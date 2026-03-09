use std::{
  fs,
  path::PathBuf,
  str::FromStr,
  sync::Mutex,
  time::Duration,
};

use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, Position, State, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const OPENAI_MODEL: &str = "gpt-4.1-mini";
const GEMINI_MODELS: [&str; 4] = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
];
const GEMINI_API_VERSIONS: [&str; 2] = ["v1beta", "v1"];
const CLAUDE_MODEL: &str = "claude-3-5-sonnet-20241022";
const INLINE_LIMIT: usize = 180;
const LONG_LIMIT: usize = 1200;
const COMPACT_SIZE: f64 = 72.0;
const WINDOW_MARGIN: f64 = 16.0;
const DEFAULT_GLOBAL_HOTKEY: &str = "Ctrl+Space";

static SENSITIVE_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
  vec![
    Regex::new(r"sk-[A-Za-z0-9]{20,}").unwrap(),
    Regex::new(r"(?i)api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{12,}").unwrap(),
    Regex::new(r"(?i)password\s*[:=]\s*\S+").unwrap(),
    Regex::new(r"(?i)Bearer\s+[A-Za-z0-9._\-]+").unwrap(),
    Regex::new(r"-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----").unwrap(),
  ]
});

#[derive(Default)]
struct AppState {
  hide_on_blur: Mutex<bool>,
  bubble_initialized: Mutex<bool>,
  current_hotkey: Mutex<String>,
  current_shortcut: Mutex<Option<Shortcut>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptHistoryItem {
  id: String,
  text: String,
  created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SuggestionResponse {
  inline: String,
  rewrite: String,
  variant: String,
  chips: Vec<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  provider: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  sensitive: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConnectionTestResult {
  ok: bool,
  message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSettings {
  selected_provider: String,
  openai_api_key: String,
  gemini_api_key: String,
  claude_api_key: String,
  local_llm_endpoint: String,
  local_llm_model: String,
  use_env_openai: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptTemplate {
  id: String,
  name: String,
  instruction: String,
}

impl Default for ProviderSettings {
  fn default() -> Self {
    Self {
      selected_provider: "mock".to_string(),
      openai_api_key: "".to_string(),
      gemini_api_key: "".to_string(),
      claude_api_key: "".to_string(),
      local_llm_endpoint: "http://127.0.0.1:11434/v1/chat/completions".to_string(),
      local_llm_model: "llama3.1:8b".to_string(),
      use_env_openai: true,
    }
  }
}

fn default_prompt_templates() -> Vec<PromptTemplate> {
  vec![
    PromptTemplate {
      id: "developer".to_string(),
      name: "개발자".to_string(),
      instruction: "기술적으로 정확하고 실행 가능한 단계, 코드 예시, 트레이드오프를 포함해 답해줘.".to_string(),
    },
    PromptTemplate {
      id: "lawyer".to_string(),
      name: "변호사".to_string(),
      instruction: "법률 문체로 사실관계, 쟁점, 리스크, 권고안을 구조화해서 작성해줘. 일반 정보이며 법률 자문 아님을 명시해줘.".to_string(),
    },
    PromptTemplate {
      id: "marketer".to_string(),
      name: "마케터".to_string(),
      instruction: "타겟 고객, 메시지, 채널, KPI 중심으로 간결하게 작성해줘.".to_string(),
    },
  ]
}

#[tauri::command]
fn has_openai_key() -> bool {
  std::env::var("OPENAI_API_KEY")
    .map(|v| !v.trim().is_empty())
    .unwrap_or(false)
}

#[tauri::command]
fn load_provider_settings(app: AppHandle) -> Result<ProviderSettings, String> {
  let path = provider_settings_path(&app)?;
  if !path.exists() {
    return Ok(ProviderSettings::default());
  }

  let raw = fs::read_to_string(path).map_err(|e| format!("read provider settings failed: {e}"))?;
  serde_json::from_str(&raw).map_err(|e| format!("parse provider settings failed: {e}"))
}

#[tauri::command]
fn save_provider_settings(settings: ProviderSettings, app: AppHandle) -> Result<(), String> {
  let path = provider_settings_path(&app)?;
  let body = serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize provider settings failed: {e}"))?;
  fs::write(path, body).map_err(|e| format!("write provider settings failed: {e}"))?;
  Ok(())
}

#[tauri::command]
fn load_prompt_templates(app: AppHandle) -> Result<Vec<PromptTemplate>, String> {
  let path = prompt_templates_path(&app)?;
  if !path.exists() {
    let defaults = default_prompt_templates();
    let body = serde_json::to_string_pretty(&defaults)
      .map_err(|e| format!("serialize templates failed: {e}"))?;
    fs::write(path, body).map_err(|e| format!("write templates failed: {e}"))?;
    return Ok(defaults);
  }

  let raw = fs::read_to_string(path).map_err(|e| format!("read templates failed: {e}"))?;
  serde_json::from_str(&raw).map_err(|e| format!("parse templates failed: {e}"))
}

#[tauri::command]
fn save_prompt_templates(templates: Vec<PromptTemplate>, app: AppHandle) -> Result<(), String> {
  let path = prompt_templates_path(&app)?;
  let body = serde_json::to_string_pretty(&templates)
    .map_err(|e| format!("serialize templates failed: {e}"))?;
  fs::write(path, body).map_err(|e| format!("write templates failed: {e}"))?;
  Ok(())
}

#[tauri::command]
fn set_hide_on_blur(enabled: bool, state: State<'_, AppState>) {
  if let Ok(mut guard) = state.hide_on_blur.lock() {
    *guard = enabled;
  }
}

#[tauri::command]
async fn test_provider_connection(provider: String, app: AppHandle) -> ProviderConnectionTestResult {
  let settings = load_settings_or_default(&app);
  let client = match reqwest::Client::builder().timeout(Duration::from_millis(4000)).build() {
    Ok(c) => c,
    Err(err) => {
      return ProviderConnectionTestResult {
        ok: false,
        message: format!("HTTP client init failed: {err}"),
      }
    }
  };

  let result = match provider.as_str() {
    "openai" => {
      let mut key = settings.openai_api_key.trim().to_string();
      if key.is_empty() && settings.use_env_openai {
        key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
      }
      if key.trim().is_empty() {
        Err("OpenAI key is empty.".to_string())
      } else {
        let res = client
          .get("https://api.openai.com/v1/models")
          .bearer_auth(key)
          .send()
          .await;
        match res {
          Ok(resp) if resp.status().is_success() => Ok("OpenAI connection OK.".to_string()),
          Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_else(|_| "<no body>".to_string());
            Err(format!("OpenAI HTTP {status}: {body}"))
          }
          Err(err) => {
            let kind = if err.is_timeout() {
              "timeout"
            } else if err.is_connect() {
              "network connect failure"
            } else {
              "request failed"
            };
            Err(format!("OpenAI {kind}: {err}"))
          }
        }
      }
    }
    "gemini" => {
      if settings.gemini_api_key.trim().is_empty() {
        Err("Gemini key is empty.".to_string())
      } else {
        Ok("Gemini key exists. Use Generate to fully validate model access.".to_string())
      }
    }
    "claude" => {
      if settings.claude_api_key.trim().is_empty() {
        Err("Claude key is empty.".to_string())
      } else {
        Ok("Claude key exists. Use Generate to fully validate model access.".to_string())
      }
    }
    "local" => {
      if settings.local_llm_endpoint.trim().is_empty() {
        Err("Local endpoint is empty.".to_string())
      } else {
        let res = client.get(settings.local_llm_endpoint.trim()).send().await;
        match res {
          Ok(_) => Ok("Local endpoint reachable.".to_string()),
          Err(err) => Err(format!("Local endpoint unreachable: {err}")),
        }
      }
    }
    _ => Ok("Mock provider does not require network.".to_string()),
  };

  match result {
    Ok(message) => ProviderConnectionTestResult { ok: true, message },
    Err(message) => ProviderConnectionTestResult { ok: false, message },
  }
}

#[tauri::command]
fn load_global_hotkey(app: AppHandle) -> Result<String, String> {
  let path = global_hotkey_path(&app)?;
  if !path.exists() {
    return Ok(DEFAULT_GLOBAL_HOTKEY.to_string());
  }
  let raw = fs::read_to_string(path).map_err(|e| format!("read global hotkey failed: {e}"))?;
  let value = raw.trim();
  if value.is_empty() {
    Ok(DEFAULT_GLOBAL_HOTKEY.to_string())
  } else {
    Ok(value.to_string())
  }
}

#[tauri::command]
fn set_global_hotkey(hotkey: String, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
  let shortcut = parse_global_hotkey(&hotkey)?;
  let global_shortcut = app.global_shortcut();

  let old_shortcut = state.current_shortcut.lock().ok().and_then(|v| v.clone());
  if let Some(old) = &old_shortcut {
    let _ = global_shortcut.unregister(old.clone());
  }

  if let Err(err) = global_shortcut.register(shortcut.clone()) {
    if let Some(old) = old_shortcut {
      let _ = global_shortcut.register(old);
    }
    return Err(format!("register global hotkey failed: {err}"));
  }

  if let Ok(mut guard) = state.current_shortcut.lock() {
    *guard = Some(shortcut);
  }
  if let Ok(mut guard) = state.current_hotkey.lock() {
    *guard = hotkey.clone();
  }

  let path = global_hotkey_path(&app)?;
  fs::write(path, &hotkey).map_err(|e| format!("write global hotkey failed: {e}"))?;
  Ok(hotkey)
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
  if let Some(main) = app.get_webview_window("main") {
    main.hide().map_err(|e| e.to_string())?;
  }
  if let Some(bubble) = app.get_webview_window("bubble") {
    bubble.hide().map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn restore_main_window(app: AppHandle) -> Result<(), String> {
  transition_bubble_to_main(&app)
}

#[tauri::command]
fn compact_main_window(app: AppHandle) -> Result<(), String> {
  transition_main_to_bubble(&app)
}

#[tauri::command]
fn exit_app(app: AppHandle) {
  app.exit(0);
}

#[tauri::command]
fn copy_and_hide(content: String, app: AppHandle) -> Result<(), String> {
  let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard init failed: {e}"))?;
  clipboard
    .set_text(content)
    .map_err(|e| format!("clipboard write failed: {e}"))?;

  if let Some(main) = app.get_webview_window("main") {
    main.hide().map_err(|e| e.to_string())?;
  }
  if let Some(bubble) = app.get_webview_window("bubble") {
    bubble.hide().map_err(|e| e.to_string())?;
  }

  Ok(())
}

#[tauri::command]
fn load_history(app: AppHandle) -> Result<Vec<PromptHistoryItem>, String> {
  let path = history_path(&app)?;
  if !path.exists() {
    return Ok(vec![]);
  }

  let raw = fs::read_to_string(path).map_err(|e| format!("read history failed: {e}"))?;
  let list: Vec<PromptHistoryItem> = serde_json::from_str(&raw).unwrap_or_default();
  Ok(list)
}

#[tauri::command]
fn save_history_item(item: PromptHistoryItem, app: AppHandle) -> Result<(), String> {
  let path = history_path(&app)?;
  let mut history = if path.exists() {
    let raw = fs::read_to_string(&path).map_err(|e| format!("read history failed: {e}"))?;
    serde_json::from_str::<Vec<PromptHistoryItem>>(&raw).unwrap_or_default()
  } else {
    vec![]
  };

  history.retain(|x| x.text != item.text);
  history.insert(0, item);
  history.truncate(50);

  let body = serde_json::to_string_pretty(&history).map_err(|e| format!("serialize history failed: {e}"))?;
  fs::write(path, body).map_err(|e| format!("write history failed: {e}"))?;
  Ok(())
}

#[tauri::command]
async fn generate_suggestions(
  text: String,
  mode: String,
  locale: String,
  provider: String,
  template_context: String,
  app: AppHandle,
) -> SuggestionResponse {
  if looks_sensitive(&text) {
    let mut mock = build_mock_suggestions(&text, &locale);
    mock.sensitive = Some(true);
    mock.warning = Some("Sensitive input detected. Cloud providers disabled for this request.".to_string());
    return mock;
  }

  if provider == "mock" {
    return build_mock_suggestions(&text, &locale);
  }

  let settings = load_settings_or_default(&app);
  let provider_timeout_ms = if provider == "local" { 5000 } else { 12000 };
  let provider_result = tokio::time::timeout(
    Duration::from_millis(provider_timeout_ms),
    generate_by_provider(&provider, &text, &mode, &locale, &template_context, &settings),
  )
  .await;

  match provider_result {
    Ok(Ok(mut response)) => {
      response.provider = Some(provider);
      sanitize_suggestions(&mut response);
      response
    }
    Ok(Err(reason)) => {
      let mut fallback = build_mock_suggestions(&text, &locale);
      fallback.warning = Some(reason);
      fallback
    }
    Err(_) => {
      let mut fallback = build_mock_suggestions(&text, &locale);
      fallback.warning = Some("Provider timeout. Switched to Mock provider.".to_string());
      fallback
    }
  }
}

async fn generate_by_provider(
  provider: &str,
  text: &str,
  mode: &str,
  locale: &str,
  template_context: &str,
  settings: &ProviderSettings,
) -> Result<SuggestionResponse, String> {
  match provider {
    "openai" => {
      let mut key = settings.openai_api_key.trim().to_string();
      if key.is_empty() && settings.use_env_openai {
        key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
      }
      if key.trim().is_empty() {
        return Err("OpenAI key not set. Using Mock provider.".to_string());
      }
      generate_openai_suggestions(text, mode, locale, template_context, &key).await
    }
    "gemini" => {
      if settings.gemini_api_key.trim().is_empty() {
        return Err("Gemini key not set. Using Mock provider.".to_string());
      }
      generate_gemini_suggestions(text, mode, locale, template_context, &settings.gemini_api_key).await
    }
    "claude" => {
      if settings.claude_api_key.trim().is_empty() {
        return Err("Claude key not set. Using Mock provider.".to_string());
      }
      generate_claude_suggestions(text, mode, locale, template_context, &settings.claude_api_key).await
    }
    "local" => {
      generate_local_suggestions(text, mode, locale, template_context, settings).await
    }
    _ => Ok(build_mock_suggestions(text, locale)),
  }
}

async fn generate_openai_suggestions(
  text: &str,
  mode: &str,
  locale: &str,
  template_context: &str,
  api_key: &str,
) -> Result<SuggestionResponse, String> {
  let client = http_client()?;
  let system_prompt = "You generate prompt-completion suggestions. Return strict JSON only with keys: inline, rewrite, variant, chips. inline is continuation only. rewrite and variant are full prompts. chips is short labels.";
  let user_prompt = build_user_prompt(text, mode, locale, template_context);

  let body = json!({
    "model": OPENAI_MODEL,
    "temperature": 0.4,
    "max_tokens": 700,
    "response_format": { "type": "json_object" },
    "messages": [
      {"role": "system", "content": system_prompt},
      {"role": "user", "content": user_prompt}
    ]
  });

  let res = client
    .post("https://api.openai.com/v1/chat/completions")
    .bearer_auth(api_key)
    .json(&body)
    .send()
    .await
    .map_err(|e| {
      if e.is_timeout() {
        format!("OpenAI request timeout: {e}")
      } else if e.is_connect() {
        format!("OpenAI connect failed: {e}")
      } else {
        format!("OpenAI request failed: {e}")
      }
    })?;

  parse_openai_like_response(res, "OpenAI").await
}

async fn generate_gemini_suggestions(
  text: &str,
  mode: &str,
  locale: &str,
  template_context: &str,
  api_key: &str,
) -> Result<SuggestionResponse, String> {
  let client = http_client()?;
  let prompt = format!(
    "You must return JSON only with keys inline, rewrite, variant, chips. {}",
    build_user_prompt(text, mode, locale, template_context)
  );

  let body_with_mime = json!({
    "contents": [{ "parts": [{ "text": prompt }] }],
    "generationConfig": {
      "temperature": 0.4,
      "responseMimeType": "application/json"
    }
  });
  let body_plain = json!({
    "contents": [{ "parts": [{ "text": prompt }] }],
    "generationConfig": {
      "temperature": 0.4
    }
  });

  let mut last_error = String::new();
  for api_version in GEMINI_API_VERSIONS {
    for model in GEMINI_MODELS {
      let url = format!(
        "https://generativelanguage.googleapis.com/{api_version}/models/{model}:generateContent?key={api_key}"
      );
      for body in [&body_with_mime, &body_plain] {
        let res = match client.post(&url).json(body).send().await {
          Ok(r) => r,
          Err(err) => {
            last_error = format!("Gemini request failed for {model} ({api_version}): {err}");
            continue;
          }
        };

        if !res.status().is_success() {
          let status = res.status();
          let err_body = res.text().await.unwrap_or_else(|_| "<no body>".to_string());
          last_error = format!("Gemini {model} ({api_version}) error {status}: {err_body}");
          continue;
        }

        let value: Value = res.json().await.map_err(|e| format!("Gemini invalid response: {e}"))?;
        let content = value["candidates"][0]["content"]["parts"][0]["text"]
          .as_str()
          .ok_or_else(|| "Gemini missing response content".to_string())?;
        let mut parsed: SuggestionResponse = serde_json::from_str(content)
          .map_err(|e| format!("Gemini JSON parse failed: {e}; raw={content}"))?;
        sanitize_suggestions(&mut parsed);
        return Ok(parsed);
      }
    }
  }

  Err(if last_error.is_empty() {
    "Gemini failed: no compatible model/version found.".to_string()
  } else {
    last_error
  })
}

async fn generate_claude_suggestions(
  text: &str,
  mode: &str,
  locale: &str,
  template_context: &str,
  api_key: &str,
) -> Result<SuggestionResponse, String> {
  let client = http_client()?;
  let system_prompt = "You generate prompt-completion suggestions. Return strict JSON only with keys inline, rewrite, variant, chips.";
  let user_prompt = build_user_prompt(text, mode, locale, template_context);

  let body = json!({
    "model": CLAUDE_MODEL,
    "max_tokens": 700,
    "temperature": 0.4,
    "system": system_prompt,
    "messages": [
      {"role": "user", "content": user_prompt}
    ]
  });

  let res = client
    .post("https://api.anthropic.com/v1/messages")
    .header("x-api-key", api_key)
    .header("anthropic-version", "2023-06-01")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Claude request failed: {e}"))?;

  if !res.status().is_success() {
    let status = res.status();
    let body = res.text().await.unwrap_or_else(|_| "<no body>".to_string());
    return Err(format!("Claude error {status}: {body}"));
  }

  let value: Value = res.json().await.map_err(|e| format!("Claude invalid response: {e}"))?;
  let content = value["content"][0]["text"]
    .as_str()
    .ok_or_else(|| "Claude missing response content".to_string())?;
  let mut parsed: SuggestionResponse = serde_json::from_str(content)
    .map_err(|e| format!("Claude JSON parse failed: {e}; raw={content}"))?;
  sanitize_suggestions(&mut parsed);
  Ok(parsed)
}

async fn generate_local_suggestions(
  text: &str,
  mode: &str,
  locale: &str,
  template_context: &str,
  settings: &ProviderSettings,
) -> Result<SuggestionResponse, String> {
  if settings.local_llm_endpoint.trim().is_empty() {
    return Err("Local endpoint not set. Using Mock provider.".to_string());
  }

  let client = http_client()?;
  let system_prompt = "You generate prompt-completion suggestions. Return strict JSON only with keys: inline, rewrite, variant, chips.";
  let user_prompt = build_user_prompt(text, mode, locale, template_context);

  let body = json!({
    "model": settings.local_llm_model,
    "temperature": 0.4,
    "max_tokens": 700,
    "response_format": { "type": "json_object" },
    "messages": [
      {"role": "system", "content": system_prompt},
      {"role": "user", "content": user_prompt}
    ]
  });

  let res = client
    .post(settings.local_llm_endpoint.trim())
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Local LLM request failed: {e}"))?;

  parse_openai_like_response(res, "Local LLM").await
}

async fn parse_openai_like_response(
  res: reqwest::Response,
  name: &str,
) -> Result<SuggestionResponse, String> {
  if !res.status().is_success() {
    let status = res.status();
    let body = res.text().await.unwrap_or_else(|_| "<no body>".to_string());
    return Err(format!("{name} error {status}: {body}"));
  }

  let value: Value = res.json().await.map_err(|e| format!("{name} invalid response: {e}"))?;
  let content = value["choices"][0]["message"]["content"]
    .as_str()
    .ok_or_else(|| format!("{name} missing response content"))?;

  let mut parsed: SuggestionResponse = serde_json::from_str(content)
    .map_err(|e| format!("{name} JSON parse failed: {e}; raw={content}"))?;
  sanitize_suggestions(&mut parsed);
  Ok(parsed)
}

fn http_client() -> Result<Client, String> {
  Client::builder()
    .connect_timeout(Duration::from_millis(4000))
    .timeout(Duration::from_millis(8000))
    .build()
    .map_err(|e| format!("client build failed: {e}"))
}

fn build_user_prompt(text: &str, mode: &str, locale: &str, template_context: &str) -> String {
  format!(
    "locale={locale}\nmode={mode}\ntemplate_context={template_context}\ninput={text}\nConstraints: inline <= 180 chars, rewrite <= 1200 chars, variant <= 1200 chars, chips length <= 5. No markdown fences."
  )
}

fn sanitize_suggestions(s: &mut SuggestionResponse) {
  s.inline = clip(&s.inline, INLINE_LIMIT);
  s.rewrite = clip(&s.rewrite, LONG_LIMIT);
  s.variant = clip(&s.variant, LONG_LIMIT);
  if s.chips.len() > 5 {
    s.chips.truncate(5);
  }
}

fn clip(value: &str, max_len: usize) -> String {
  if value.chars().count() <= max_len {
    return value.to_string();
  }
  value.chars().take(max_len.saturating_sub(1)).collect::<String>() + "…"
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
  let mut dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app data dir failed: {e}"))?;
  fs::create_dir_all(&dir).map_err(|e| format!("create app data dir failed: {e}"))?;
  dir.push("history.json");
  Ok(dir)
}

fn provider_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
  let mut dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app data dir failed: {e}"))?;
  fs::create_dir_all(&dir).map_err(|e| format!("create app data dir failed: {e}"))?;
  dir.push("provider_settings.json");
  Ok(dir)
}

fn global_hotkey_path(app: &AppHandle) -> Result<PathBuf, String> {
  let mut dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app data dir failed: {e}"))?;
  fs::create_dir_all(&dir).map_err(|e| format!("create app data dir failed: {e}"))?;
  dir.push("global_hotkey.txt");
  Ok(dir)
}

fn parse_global_hotkey(input: &str) -> Result<Shortcut, String> {
  if let Ok(shortcut) = Shortcut::from_str(input) {
    return Ok(shortcut);
  }

  let mut mods = Modifiers::empty();
  let mut key_token: Option<String> = None;
  for token in input.split('+').map(|t| t.trim()).filter(|t| !t.is_empty()) {
    let upper = token.to_uppercase();
    match upper.as_str() {
      "CTRL" | "CONTROL" => mods |= Modifiers::CONTROL,
      "ALT" | "OPTION" => mods |= Modifiers::ALT,
      "SHIFT" => mods |= Modifiers::SHIFT,
      "CMD" | "COMMAND" | "META" | "SUPER" => mods |= Modifiers::SUPER,
      _ => {
        if key_token.is_some() {
          return Err("invalid hotkey format: multiple key tokens".to_string());
        }
        key_token = Some(upper);
      }
    }
  }

  if mods.is_empty() {
    return Err("at least one modifier is required".to_string());
  }
  let key = parse_hotkey_code(key_token.as_deref().ok_or_else(|| "missing key token".to_string())?)?;
  Ok(Shortcut::new(Some(mods), key))
}

fn parse_hotkey_code(token: &str) -> Result<Code, String> {
  let code = match token {
    "SPACE" => Code::Space,
    "ENTER" | "RETURN" => Code::Enter,
    "TAB" => Code::Tab,
    "ESC" | "ESCAPE" => Code::Escape,
    "BACKSPACE" => Code::Backspace,
    "DELETE" => Code::Delete,
    "ARROWUP" | "UP" => Code::ArrowUp,
    "ARROWDOWN" | "DOWN" => Code::ArrowDown,
    "ARROWLEFT" | "LEFT" => Code::ArrowLeft,
    "ARROWRIGHT" | "RIGHT" => Code::ArrowRight,
    "A" => Code::KeyA, "B" => Code::KeyB, "C" => Code::KeyC, "D" => Code::KeyD, "E" => Code::KeyE,
    "F" => Code::KeyF, "G" => Code::KeyG, "H" => Code::KeyH, "I" => Code::KeyI, "J" => Code::KeyJ,
    "K" => Code::KeyK, "L" => Code::KeyL, "M" => Code::KeyM, "N" => Code::KeyN, "O" => Code::KeyO,
    "P" => Code::KeyP, "Q" => Code::KeyQ, "R" => Code::KeyR, "S" => Code::KeyS, "T" => Code::KeyT,
    "U" => Code::KeyU, "V" => Code::KeyV, "W" => Code::KeyW, "X" => Code::KeyX, "Y" => Code::KeyY,
    "Z" => Code::KeyZ,
    "0" => Code::Digit0, "1" => Code::Digit1, "2" => Code::Digit2, "3" => Code::Digit3, "4" => Code::Digit4,
    "5" => Code::Digit5, "6" => Code::Digit6, "7" => Code::Digit7, "8" => Code::Digit8, "9" => Code::Digit9,
    "F1" => Code::F1, "F2" => Code::F2, "F3" => Code::F3, "F4" => Code::F4, "F5" => Code::F5, "F6" => Code::F6,
    "F7" => Code::F7, "F8" => Code::F8, "F9" => Code::F9, "F10" => Code::F10, "F11" => Code::F11, "F12" => Code::F12,
    _ => return Err(format!("unsupported hotkey key: {token}")),
  };
  Ok(code)
}

fn prompt_templates_path(app: &AppHandle) -> Result<PathBuf, String> {
  let mut dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app data dir failed: {e}"))?;
  fs::create_dir_all(&dir).map_err(|e| format!("create app data dir failed: {e}"))?;
  dir.push("prompt_templates.json");
  Ok(dir)
}

fn load_settings_or_default(app: &AppHandle) -> ProviderSettings {
  match provider_settings_path(app) {
    Ok(path) => {
      if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(parsed) = serde_json::from_str::<ProviderSettings>(&raw) {
          return parsed;
        }
      }
      ProviderSettings::default()
    }
    Err(_) => ProviderSettings::default(),
  }
}

fn has_korean(text: &str) -> bool {
  text.chars().any(|c| ('가'..='힣').contains(&c))
}

fn looks_sensitive(text: &str) -> bool {
  if text.trim().is_empty() {
    return false;
  }
  SENSITIVE_PATTERNS.iter().any(|r| r.is_match(text))
}

fn build_mock_suggestions(text: &str, _locale: &str) -> SuggestionResponse {
  let korean = has_korean(text);
  let source = if text.trim().is_empty() {
    if korean {
      "요청을 구체적으로 작성해줘.".to_string()
    } else {
      "Write a detailed request.".to_string()
    }
  } else {
    text.trim().to_string()
  };

  let inline = if korean {
    if source.contains("요약") {
      " 핵심 포인트 3개와 실행 항목을 불릿으로 정리해줘.".to_string()
    } else {
      " 목적, 제약사항, 원하는 출력 형식을 포함해줘.".to_string()
    }
  } else if source.to_lowercase().contains("summary") {
    " Add 3 key takeaways and 2 action items in bullets.".to_string()
  } else {
    " Add context, constraints, and desired output format.".to_string()
  };

  let rewrite = if korean {
    format!(
      "아래 요청을 더 명확하게 다시 작성해줘:\n{}\n\n요구사항:\n- 목표를 한 문장으로 먼저 제시\n- 출력 형식을 명시\n- 길이 제한과 톤을 포함",
      source
    )
  } else {
    format!(
      "Rewrite this prompt clearly:\n{}\n\nRequirements:\n- Start with one-sentence objective\n- Specify output format\n- Include length and tone constraints",
      source
    )
  };

  let variant = if korean {
    format!(
      "너는 실무 도우미야. 다음 요청을 실행 가능한 단계로 답해줘.\n요청: {}\n출력: 1) 핵심 요약 2) 단계별 실행안 3) 리스크",
      source
    )
  } else {
    format!(
      "You are a practical assistant. Answer with actionable steps.\nRequest: {}\nOutput: 1) quick summary 2) step-by-step plan 3) risks",
      source
    )
  };

  let chips = if korean {
    vec!["짧게".to_string(), "격식".to_string(), "불릿".to_string()]
  } else {
    vec!["concise".to_string(), "formal".to_string(), "bullet".to_string()]
  };

  let mut response = SuggestionResponse {
    inline,
    rewrite,
    variant,
    chips,
    provider: Some("mock".to_string()),
    sensitive: Some(false),
    warning: None,
  };

  sanitize_suggestions(&mut response);
  response
}

fn position_bubble_top_right(app: &AppHandle) -> Result<(), String> {
  let bubble = app
    .get_webview_window("bubble")
    .ok_or_else(|| "bubble window not found".to_string())?;
  let monitor = bubble
    .current_monitor()
    .map_err(|e| e.to_string())?
    .or(bubble.primary_monitor().map_err(|e| e.to_string())?);
  if let Some(monitor) = monitor {
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let pos = monitor.position();
    let monitor_x = pos.x as f64 / scale;
    let monitor_y = pos.y as f64 / scale;
    let monitor_width = size.width as f64 / scale;
    let x = monitor_x + monitor_width - COMPACT_SIZE - WINDOW_MARGIN;
    let y = monitor_y + WINDOW_MARGIN;
    bubble
      .set_position(Position::Logical(LogicalPosition::new(x.max(0.0), y.max(0.0))))
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

fn transition_main_to_bubble(app: &AppHandle) -> Result<(), String> {
  let main = app
    .get_webview_window("main")
    .ok_or_else(|| "main window not found".to_string())?;
  let bubble = app
    .get_webview_window("bubble")
    .ok_or_else(|| "bubble window not found".to_string())?;

  let state = app.state::<AppState>();
  let should_init = state
    .bubble_initialized
    .lock()
    .map(|v| !*v)
    .unwrap_or(true);
  if should_init {
    position_bubble_top_right(app)?;
    if let Ok(mut guard) = state.bubble_initialized.lock() {
      *guard = true;
    }
  }

  let _ = main.emit("window-transition", "fade-out");
  std::thread::sleep(Duration::from_millis(120));
  main.hide().map_err(|e| e.to_string())?;
  bubble.show().map_err(|e| e.to_string())?;
  let _ = bubble.emit("window-transition", "fade-in");
  Ok(())
}

fn transition_bubble_to_main(app: &AppHandle) -> Result<(), String> {
  let main = app
    .get_webview_window("main")
    .ok_or_else(|| "main window not found".to_string())?;
  let bubble = app
    .get_webview_window("bubble")
    .ok_or_else(|| "bubble window not found".to_string())?;

  let _ = bubble.emit("window-transition", "fade-out");
  std::thread::sleep(Duration::from_millis(120));
  bubble.hide().map_err(|e| e.to_string())?;
  main.show().map_err(|e| e.to_string())?;
  main.set_focus().map_err(|e| e.to_string())?;
  let _ = main.emit("window-transition", "fade-in");
  main
    .emit("focus-editor", ())
    .map_err(|e| format!("emit failed: {e}"))?;
  Ok(())
}

fn toggle_window(app: &AppHandle) -> Result<(), String> {
  let main = app
    .get_webview_window("main")
    .ok_or_else(|| "main window not found".to_string())?;
  let bubble = app
    .get_webview_window("bubble")
    .ok_or_else(|| "bubble window not found".to_string())?;

  if bubble.is_visible().map_err(|e| e.to_string())? {
    return transition_bubble_to_main(app);
  }

  if main.is_visible().map_err(|e| e.to_string())? {
    main.hide().map_err(|e| e.to_string())?;
    bubble.hide().map_err(|e| e.to_string())?;
    return Ok(());
  }

  main.show().map_err(|e| e.to_string())?;
  main.set_focus().map_err(|e| e.to_string())?;
  let _ = main.emit("window-transition", "fade-in");
  main
    .emit("focus-editor", ())
    .map_err(|e| format!("emit failed: {e}"))?;
  Ok(())
}

fn main() {
  tauri::Builder::default()
    .manage(AppState {
      hide_on_blur: Mutex::new(true),
      bubble_initialized: Mutex::new(false),
      current_hotkey: Mutex::new(DEFAULT_GLOBAL_HOTKEY.to_string()),
      current_shortcut: Mutex::new(None),
    })
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
          if event.state() == ShortcutState::Pressed {
            let _ = toggle_window(app);
          }
        })
        .build(),
    )
    .setup(|app| {
      let configured_hotkey = load_global_hotkey(app.handle().clone()).unwrap_or_else(|_| DEFAULT_GLOBAL_HOTKEY.to_string());
      let shortcut = parse_global_hotkey(&configured_hotkey)
        .unwrap_or_else(|_| Shortcut::new(Some(Modifiers::CONTROL), Code::Space));
      app
        .global_shortcut()
        .register(shortcut.clone())
        .map_err(|e| format!("shortcut register failed: {e}"))?;
      let state = app.state::<AppState>();
      if let Ok(mut guard) = state.current_hotkey.lock() {
        *guard = configured_hotkey;
      }
      if let Ok(mut guard) = state.current_shortcut.lock() {
        *guard = Some(shortcut);
      }

      if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
          if let WindowEvent::Focused(false) = event {
            let state = app_handle.state::<AppState>();
            let should_hide = state.hide_on_blur.lock().map(|v| *v).unwrap_or(true);
            if should_hide {
              let _ = transition_main_to_bubble(&app_handle);
            }
          }
        });
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      has_openai_key,
      test_provider_connection,
      load_global_hotkey,
      set_global_hotkey,
      load_provider_settings,
      save_provider_settings,
      load_prompt_templates,
      save_prompt_templates,
      set_hide_on_blur,
      hide_main_window,
      restore_main_window,
      compact_main_window,
      exit_app,
      copy_and_hide,
      load_history,
      save_history_item,
      generate_suggestions
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
