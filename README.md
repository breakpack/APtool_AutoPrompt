# Prompt Autocomplete (Tauri + React)

MVP standalone desktop app for Windows-first global prompt autocomplete.

## Features
- `Ctrl+Space` global hotkey toggles the palette window.
- Ghost text inline completion + 2 alternatives (`rewrite`, `variant`).
- Keyboard-first actions:
  - `Tab`: accept full inline ghost text
  - `Alt+Right`: accept next ghost word
  - `Ctrl+J` / `Ctrl+K`: cycle suggestion modes
  - `Enter`: apply rewrite/variant when selected
  - `Ctrl+Enter`: copy current prompt to clipboard and hide
  - `Esc`: hide window
- Debounced suggestion generation (250ms) with race-safe generation IDs.
- Local history (last 50 accepted prompts) stored via Rust backend in app data.
- Multi-provider support: Mock, OpenAI, Gemini, Claude, Local LLM (OpenAI-compatible endpoint).
- Provider settings screen to save API keys and local endpoint/model.
- Role-based prompt templates (직군 프리셋) with dropdown selection and editor.
- Configurable global hotkey capture in Key Settings.
- Sensitive-input guard: auto-disables cloud providers for possible key/password content.

## Stack
- Tauri v2 (Rust backend)
- React + TypeScript + Vite frontend
- Global hotkey plugin: `tauri-plugin-global-shortcut`

## Run (dev)
1. Install deps:
```bash
npm install
```
2. Run app:
```bash
npm run tauri dev
```

## Build
```bash
npm run tauri build
```

## Provider Setup
1. Open the app and click `Settings`.
2. Configure one or more providers:
   - OpenAI key (or environment fallback)
   - Gemini key
   - Claude key
   - Local LLM endpoint + model
3. Click `Save` and return to editor.
4. Choose the active provider from the top dropdown.

## Template Presets (직군)
1. Click `Settings`.
2. In `Prompt Templates (직군)`, add/edit/delete templates (e.g., 개발자, 변호사).
3. Save settings.
4. In editor, choose template from `Template` dropdown.
5. Selected template instructions are applied to suggestion generation.

## OpenAI Env Setup (optional)
1. Set env var before launching:
```bash
# PowerShell
$env:OPENAI_API_KEY="your_key"
npm run tauri dev
```
2. Enable `Use OPENAI_API_KEY env fallback` in Settings.
3. If key is missing or request fails/timeouts, app falls back to Mock provider.

## Architecture

### Frontend
- `src/App.tsx`: palette UI, ghost-text overlay editor, keybindings, history UI, settings.
- `src/lib/mockProvider.ts`: local deterministic suggestion provider.
- `src/lib/openaiProvider.ts`: invokes backend command `generate_suggestions` for selected provider.
- `src/lib/sensitive.ts`: sensitive-input detection patterns.

### Backend
- `src-tauri/src/main.rs`:
  - global hotkey registration (`Ctrl+Space`) and window toggle
  - focus event emit (`focus-editor`) on show
  - hide-on-blur setting
  - command handlers:
    - `generate_suggestions(text, mode, locale, provider, template_context)`
    - `load_provider_settings()` / `save_provider_settings(settings)`
    - `copy_and_hide(content)`
    - `load_history()` / `save_history_item(item)`
    - `has_openai_key()` / `set_hide_on_blur(enabled)` / `hide_main_window()`

## Suggestion Response Schema
All providers conform to:
```json
{
  "inline": "string continuation",
  "rewrite": "string full rewrite",
  "variant": "string alternative",
  "chips": ["short option", "..."]
}
```
Limits:
- `inline <= 180 chars`
- `rewrite <= 1200 chars`
- `variant <= 1200 chars`

## Notes
- First suggestion target latency is achieved by 250ms debounce + lightweight mock provider.
- Window compacts to the top-right on blur (configurable).
- If network/API is unavailable, app still works fully in Mock mode.
