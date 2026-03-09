import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import appIcon from './assets/message-square-refresh-svgrepo-com.svg';
import { MockProvider } from './lib/mockProvider';
import { UnifiedProvider } from './lib/openaiProvider';
import { containsSensitiveContent } from './lib/sensitive';
import {
  copyAndHide,
  loadHistory,
  loadGlobalHotkey,
  loadPromptTemplates,
  loadProviderSettings,
  saveHistory,
  savePromptTemplates,
  saveProviderSettings,
  setGlobalHotkey,
  setHideOnBlur,
  testProviderConnection
} from './lib/tauriClient';
import type {
  AppSettings,
  PromptHistoryItem,
  PromptTemplate,
  ProviderId,
  ProviderSettings,
  SuggestionMode,
  SuggestionResponse
} from './types';

const MODES: SuggestionMode[] = ['inline', 'rewrite', 'variant'];
const PROVIDERS: ProviderId[] = ['mock', 'openai', 'gemini', 'claude', 'local'];
const EMPTY_SUGGESTIONS: SuggestionResponse = {
  inline: '',
  rewrite: '',
  variant: '',
  chips: [],
  provider: 'mock'
};
const SETTINGS_KEY = 'prompt-autocomplete-settings';

const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  selectedProvider: 'mock',
  openaiApiKey: '',
  geminiApiKey: '',
  claudeApiKey: '',
  localLlmEndpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  localLlmModel: 'llama3.1:8b',
  useEnvOpenai: true
};

type ResizeDirection =
  | 'North'
  | 'South'
  | 'East'
  | 'West'
  | 'NorthEast'
  | 'NorthWest'
  | 'SouthEast'
  | 'SouthWest';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function modeLabel(mode: SuggestionMode): string {
  if (mode === 'inline') return 'Inline';
  if (mode === 'rewrite') return 'Rewrite';
  return 'Variant';
}

function providerLabel(provider: ProviderId): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'claude') return 'Claude';
  if (provider === 'local') return 'Local LLM';
  return 'Mock';
}

function quickInlineContinuation(text: string): string {
  const normalized = text.trim();
  if (!normalized) return '';
  const isKo = /[가-힣]/.test(normalized);
  if (isKo) {
    if (normalized.includes('요약')) return ' 핵심만 불릿으로 정리해줘.';
    if (normalized.includes('이메일')) return ' 수신자/목적/요청사항을 명확히 넣어줘.';
    return ' 목적과 출력 형식을 한 줄로 덧붙여줘.';
  }
  if (/summar|summary/i.test(normalized)) return ' Add key points in short bullets.';
  if (/email/i.test(normalized)) return ' Include recipient, intent, and clear ask.';
  return ' Add goal, constraints, and output format.';
}

function createTemplate(): PromptTemplate {
  return {
    id: `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '새 템플릿',
    instruction: ''
  };
}

export default function App() {
  const currentWindow = useMemo(() => getCurrentWindow(), []);
  const isBubbleWindow = currentWindow.label === 'bubble';
  const [view, setView] = useState<'editor' | 'key-settings' | 'template-settings'>('editor');
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestionResponse>(EMPTY_SUGGESTIONS);
  const [selectedModeIndex, setSelectedModeIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<PromptHistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [warning, setWarning] = useState('');
  const [providerDisconnected, setProviderDisconnected] = useState(false);
  const [transitionClass, setTransitionClass] = useState('');
  const [hotkeyDraft, setHotkeyDraft] = useState('Ctrl+Space');
  const [capturingHotkey, setCapturingHotkey] = useState(false);
  const [hotkeyStatus, setHotkeyStatus] = useState('');
  const [providerSaveStatus, setProviderSaveStatus] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { hideOnBlur: true, selectedTemplateId: '', allowMockFallback: true, retriggerWordLength: 6 };
    try {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        hideOnBlur: parsed.hideOnBlur ?? true,
        selectedTemplateId: parsed.selectedTemplateId ?? '',
        allowMockFallback: parsed.allowMockFallback ?? true,
        retriggerWordLength: parsed.retriggerWordLength ?? 6
      };
    } catch {
      return { hideOnBlur: true, selectedTemplateId: '', allowMockFallback: true, retriggerWordLength: 6 };
    }
  });

  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [providerDraft, setProviderDraft] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [templateDrafts, setTemplateDrafts] = useState<PromptTemplate[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const generationIdRef = useRef(0);
  const retriggerBucketRef = useRef<string>('');
  const mockProvider = useMemo(() => new MockProvider(), []);
  const unifiedProvider = useMemo(() => new UnifiedProvider(), []);

  const selectedMode = MODES[selectedModeIndex];
  const sensitive = containsSensitiveContent(text);
  const cloudProvider =
    providerSettings.selectedProvider === 'openai' ||
    providerSettings.selectedProvider === 'gemini' ||
    providerSettings.selectedProvider === 'claude';
  const activeProvider: ProviderId = sensitive && cloudProvider ? 'mock' : providerSettings.selectedProvider;

  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === settings.selectedTemplateId),
    [templates, settings.selectedTemplateId]
  );
  const templateContext = selectedTemplate
    ? `직군: ${selectedTemplate.name}\n지침: ${selectedTemplate.instruction}`
    : '';

  const filteredHistory = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    if (!query) return history;
    return history.filter((item) => item.text.toLowerCase().includes(query));
  }, [history, historyQuery]);

  const ghostText = selectedMode === 'inline' ? suggestions.inline : '';

  async function refreshSuggestions(currentText: string) {
    if (!currentText.trim()) {
      setSuggestions(EMPTY_SUGGESTIONS);
      setWarning('');
      setProviderDisconnected(false);
      setLoading(false);
      return;
    }

    const generationId = ++generationIdRef.current;
    setLoading(true);

    try {
      const response =
        activeProvider === 'mock'
          ? await mockProvider.generate(currentText, navigator.language || 'en-US', 'mock', templateContext)
          : await unifiedProvider.generate(
              currentText,
              navigator.language || 'en-US',
              activeProvider,
              templateContext
            );

      if (generationId !== generationIdRef.current) return;
      const fallbackFromProvider = activeProvider !== 'mock' && response.provider === 'mock';
      if (fallbackFromProvider && !settings.allowMockFallback) {
        setSuggestions(EMPTY_SUGGESTIONS);
        setProviderDisconnected(true);
        setWarning('연결이 끊겼습니다.');
      } else {
        setSuggestions(response);
        setProviderDisconnected(false);
        setWarning(response.warning ?? '');
      }
    } catch {
      if (generationId !== generationIdRef.current) return;
      if (settings.allowMockFallback) {
        const fallback = await mockProvider.generate(currentText, navigator.language || 'en-US', 'mock', templateContext);
        if (generationId !== generationIdRef.current) return;
        setSuggestions(fallback);
        setProviderDisconnected(false);
        setWarning('Provider call failed, switched to Mock suggestions.');
      } else {
        setSuggestions(EMPTY_SUGGESTIONS);
        setProviderDisconnected(true);
        setWarning('연결이 끊겼습니다.');
      }
    } finally {
      if (generationId === generationIdRef.current) setLoading(false);
    }
  }

  function maybeRetriggerByWordLength(currentText: string) {
    const threshold = Math.max(2, Number(settings.retriggerWordLength || 0));
    const trailing = currentText.match(/([^\s]+)$/)?.[1] ?? '';
    if (!trailing) {
      retriggerBucketRef.current = '';
      return;
    }
    const bucket = Math.floor(trailing.length / threshold);
    if (bucket <= 0) {
      retriggerBucketRef.current = '';
      return;
    }
    const signature = `${trailing}:${bucket}:${threshold}`;
    if (retriggerBucketRef.current === signature) return;
    retriggerBucketRef.current = signature;
    void refreshSuggestions(currentText);
  }

  function acceptInlineFull() {
    if (!suggestions.inline) return;
    setText((prev) => `${prev}${suggestions.inline}`);
  }

  function acceptInlineNextWord() {
    const inline = suggestions.inline;
    if (!inline) return;
    const trimmedStart = inline.match(/^\s*/)?.[0] ?? '';
    const after = inline.slice(trimmedStart.length);
    const nextWord = after.split(/\s+/).find(Boolean) ?? '';
    const accepted = `${trimmedStart}${nextWord}`;
    if (!nextWord) return;

    setText((prev) => `${prev}${accepted}`);
    setSuggestions((prev) => ({ ...prev, inline: inline.slice(accepted.length) }));
  }

  function cycleMode(direction: 1 | -1) {
    setSelectedModeIndex((prev) => (prev + direction + MODES.length) % MODES.length);
  }

  async function commitCopyAndHide() {
    const trimmed = text.trim();
    if (!trimmed) return;

    const item: PromptHistoryItem = { id: uid(), text: trimmed, createdAt: new Date().toISOString() };
    await saveHistory(item);
    setHistory((prev) => [item, ...prev].slice(0, 50));
    await copyAndHide(trimmed);
  }

  function applySelectedSuggestion() {
    if (selectedMode === 'inline') return;
    const replacement = selectedMode === 'rewrite' ? suggestions.rewrite : suggestions.variant;
    if (!replacement) return;
    setText(replacement);
    setSelectedModeIndex(0);
  }

  useEffect(() => {
    document.body.classList.toggle('bubble-window', isBubbleWindow);
    document.body.classList.toggle('main-window', !isBubbleWindow);
    return () => {
      document.body.classList.remove('bubble-window');
      document.body.classList.remove('main-window');
    };
  }, [isBubbleWindow]);

  useEffect(() => {
    if (isBubbleWindow) return;
    void loadHistory().then(setHistory).catch(() => setHistory([]));
    void loadProviderSettings()
      .then((loaded) => {
        setProviderSettings(loaded);
        setProviderDraft(loaded);
      })
      .catch(() => {
        setProviderSettings(DEFAULT_PROVIDER_SETTINGS);
        setProviderDraft(DEFAULT_PROVIDER_SETTINGS);
      });
    void loadPromptTemplates()
      .then((loaded) => {
        setTemplates(loaded);
        setTemplateDrafts(loaded);
      })
      .catch(() => {
        setTemplates([]);
        setTemplateDrafts([]);
      });
    void setHideOnBlur(settings.hideOnBlur).catch(() => undefined);
    void loadGlobalHotkey()
      .then((value) => setHotkeyDraft(value))
      .catch(() => setHotkeyDraft('Ctrl+Space'));
  }, [isBubbleWindow]);

  useEffect(() => {
    if (!capturingHotkey) return;
    if (view !== 'key-settings') return;

    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setCapturingHotkey(false);
        setHotkeyStatus('Capture canceled.');
        return;
      }

      const key = normalizeHotkeyKey(event);
      if (!key) return;

      const mods: string[] = [];
      if (event.ctrlKey) mods.push('Ctrl');
      if (event.altKey) mods.push('Alt');
      if (event.shiftKey) mods.push('Shift');
      if (event.metaKey) mods.push('Meta');

      if (mods.length === 0) {
        setHotkeyStatus('At least one modifier is required.');
        return;
      }

      const hotkey = [...mods, key].join('+');
      setHotkeyDraft(hotkey);
      setCapturingHotkey(false);
      setHotkeyStatus(`Captured: ${hotkey}`);
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [capturingHotkey, view]);

  useEffect(() => {
    if (isBubbleWindow) return;
    if (templates.length > 0 && !templates.some((tpl) => tpl.id === settings.selectedTemplateId)) {
      setSettings((prev) => ({ ...prev, selectedTemplateId: '' }));
    }
  }, [templates, settings.selectedTemplateId, isBubbleWindow]);

  useEffect(() => {
    if (isBubbleWindow) return;
    const timeout = setTimeout(() => {
      if (view === 'editor') {
        void refreshSuggestions(text);
      }
    }, 120);
    return () => clearTimeout(timeout);
  }, [text, activeProvider, templateContext, view, isBubbleWindow, settings.allowMockFallback]);

  useEffect(() => {
    if (isBubbleWindow) {
      setTransitionClass('fade-in');
      const t = setTimeout(() => setTransitionClass(''), 220);
      return () => clearTimeout(t);
    }
  }, [isBubbleWindow]);

  useEffect(() => {
    const unlistenFocusPromise = listen('focus-editor', () => {
      setTimeout(() => textareaRef.current?.focus(), 10);
    });
    const unlistenTransitionPromise = listen<string>('window-transition', (event) => {
      if (event.payload === 'fade-in') {
        setTransitionClass('fade-in');
        setTimeout(() => setTransitionClass(''), 220);
      } else if (event.payload === 'fade-out') {
        setTransitionClass('fade-out');
      }
    });
    return () => {
      void unlistenFocusPromise.then((unlisten) => unlisten());
      void unlistenTransitionPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (isBubbleWindow) return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    void setHideOnBlur(settings.hideOnBlur).catch(() => undefined);
  }, [settings, isBubbleWindow]);

  async function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      await invoke('hide_main_window');
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'enter') {
      event.preventDefault();
      await commitCopyAndHide();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      acceptInlineFull();
      return;
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      acceptInlineNextWord();
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      cycleMode(1);
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      cycleMode(-1);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && selectedMode !== 'inline') {
      event.preventDefault();
      applySelectedSuggestion();
    }
  }

  function updateTemplateById(id: string, patch: Partial<PromptTemplate>) {
    setTemplateDrafts((prev) => prev.map((tpl) => (tpl.id === id ? { ...tpl, ...patch } : tpl)));
  }

  function deleteTemplateById(id: string) {
    setTemplateDrafts((prev) => prev.filter((tpl) => tpl.id !== id));
  }

  function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest('button, input, select, textarea, a, label'));
  }

  async function handleTitlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (isInteractiveTarget(event.target)) return;
    await getCurrentWindow().startDragging();
  }

  function renderWindowControls() {
    return (
      <div className="window-controls">
        <button className="tiny window-btn" onClick={() => void invoke('compact_main_window')} title="Minimize to bubble">
          -
        </button>
        <button className="tiny window-btn danger" onClick={() => void invoke('exit_app')} title="Exit app">
          x
        </button>
      </div>
    );
  }

  async function startResize(direction: ResizeDirection) {
    await currentWindow.startResizeDragging(direction);
  }

  function renderResizeHandles() {
    if (isBubbleWindow) return null;
    return (
      <>
        <div className="resize-handle n" onPointerDown={() => void startResize('North')} />
        <div className="resize-handle s" onPointerDown={() => void startResize('South')} />
        <div className="resize-handle e" onPointerDown={() => void startResize('East')} />
        <div className="resize-handle w" onPointerDown={() => void startResize('West')} />
        <div className="resize-handle ne" onPointerDown={() => void startResize('NorthEast')} />
        <div className="resize-handle nw" onPointerDown={() => void startResize('NorthWest')} />
        <div className="resize-handle se" onPointerDown={() => void startResize('SouthEast')} />
        <div className="resize-handle sw" onPointerDown={() => void startResize('SouthWest')} />
      </>
    );
  }

  function normalizeHotkeyKey(event: globalThis.KeyboardEvent): string | null {
    const key = event.key;
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;
    if (key === ' ') return 'Space';
    if (key === 'ArrowUp') return 'ArrowUp';
    if (key === 'ArrowDown') return 'ArrowDown';
    if (key === 'ArrowLeft') return 'ArrowLeft';
    if (key === 'ArrowRight') return 'ArrowRight';
    if (key === 'Escape') return 'Escape';
    if (key === 'Enter') return 'Enter';
    if (key === 'Tab') return 'Tab';
    if (key === 'Backspace') return 'Backspace';
    if (key === 'Delete') return 'Delete';
    if (/^F\\d{1,2}$/i.test(key)) return key.toUpperCase();
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
    if (/^[0-9]$/.test(key)) return key;
    return null;
  }

  async function retryProviderRequest() {
    if (!text.trim()) return;
    setProviderDisconnected(false);
    setWarning('');
    await refreshSuggestions(text);
  }

  if (isBubbleWindow) {
    return (
      <div className={`app compact-app ${transitionClass}`}>
        <div
          className="compact-bubble"
          onPointerDown={async () => {
            await getCurrentWindow().startDragging();
          }}
          aria-label="Restore window"
          title="Restore"
        >
          <button
            className="compact-restore"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={async () => {
              await invoke('restore_main_window');
            }}
            aria-label="Restore window"
            title="Restore"
          >
            <img className="compact-icon-img" src={appIcon} alt="App icon" draggable={false} />
          </button>
        </div>
      </div>
    );
  }

  if (view === 'key-settings') {
    return (
      <div className={`app ${transitionClass}`}>
        {renderResizeHandles()}
        <div className="title-row" onPointerDown={(event) => void handleTitlePointerDown(event)}>
          <strong>Key Settings</strong>
          <div className="title-actions">
            <div className="controls">
              <button className="tiny" onClick={() => setView('template-settings')}>
                Template Settings
              </button>
              <button
                className="tiny"
                onClick={async () => {
                  setProviderSaveStatus('');
                  await saveProviderSettings(providerDraft);
                  try {
                    const applied = await setGlobalHotkey(hotkeyDraft);
                    setHotkeyDraft(applied);
                    setHotkeyStatus(`Saved: ${applied}`);
                  } catch (err) {
                    setHotkeyStatus(String(err));
                  }
                  setProviderSettings(providerDraft);
                  if (providerDraft.selectedProvider === 'mock') {
                    setProviderSaveStatus('Saved. Mock provider selected.');
                    setView('editor');
                    return;
                  }
                  const test = await testProviderConnection(providerDraft.selectedProvider);
                  setProviderSaveStatus(test.message);
                  if (test.ok) {
                    setView('editor');
                  }
                }}
              >
                Save
              </button>
              <button
                className="tiny"
                onClick={() => {
                  setProviderDraft(providerSettings);
                  setView('editor');
                }}
              >
                Back
              </button>
            </div>
            {renderWindowControls()}
          </div>
        </div>

        <div className="settings-grid">
          <label className="field">
            <span>Default Provider</span>
            <select
              value={providerDraft.selectedProvider}
              onChange={(e) => setProviderDraft((prev) => ({ ...prev, selectedProvider: e.target.value as ProviderId }))}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Global Hotkey</span>
            <div className="hotkey-row">
              <input type="text" value={hotkeyDraft} readOnly />
              <button
                className="tiny"
                onClick={() => {
                  setCapturingHotkey((prev) => !prev);
                  setHotkeyStatus(capturingHotkey ? '' : 'Press key combination...');
                }}
              >
                {capturingHotkey ? 'Cancel' : 'Capture'}
              </button>
              <button
                className="tiny"
                onClick={async () => {
                  try {
                    const applied = await setGlobalHotkey(hotkeyDraft);
                    setHotkeyDraft(applied);
                    setHotkeyStatus(`Applied: ${applied}`);
                  } catch (err) {
                    setHotkeyStatus(String(err));
                  }
                }}
              >
                Apply
              </button>
            </div>
            {hotkeyStatus && <span className="hotkey-status">{hotkeyStatus}</span>}
          </label>

          <label className="field inline-field">
            <span>Allow Mock fallback when provider fails</span>
            <input
              type="checkbox"
              checked={settings.allowMockFallback}
              onChange={(event) => setSettings((prev) => ({ ...prev, allowMockFallback: event.target.checked }))}
            />
          </label>

          <label className="field">
            <span>Retrigger request by word length (N)</span>
            <input
              type="number"
              min={2}
              max={30}
              value={settings.retriggerWordLength}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  retriggerWordLength: Math.max(2, Math.min(30, Number(event.target.value) || 2))
                }))
              }
            />
          </label>

          <label className="field">
            <span>OpenAI API Key</span>
            <input
              type="password"
              value={providerDraft.openaiApiKey}
              onChange={(e) => setProviderDraft((prev) => ({ ...prev, openaiApiKey: e.target.value }))}
              placeholder="sk-..."
            />
          </label>

          <label className="field inline-field">
            <span>Use OPENAI_API_KEY env fallback</span>
            <input
              type="checkbox"
              checked={providerDraft.useEnvOpenai}
              onChange={(e) => setProviderDraft((prev) => ({ ...prev, useEnvOpenai: e.target.checked }))}
            />
          </label>

          <label className="field">
            <span>Gemini API Key</span>
            <input
              type="password"
              value={providerDraft.geminiApiKey}
              onChange={(e) => setProviderDraft((prev) => ({ ...prev, geminiApiKey: e.target.value }))}
              placeholder="AIza..."
            />
          </label>

          <label className="field">
            <span>Claude API Key</span>
            <input
              type="password"
              value={providerDraft.claudeApiKey}
              onChange={(e) => setProviderDraft((prev) => ({ ...prev, claudeApiKey: e.target.value }))}
              placeholder="sk-ant-..."
            />
          </label>

          <label className="field">
            <span>Local LLM Endpoint (OpenAI-compatible)</span>
            <input
              type="text"
              value={providerDraft.localLlmEndpoint}
              onChange={(e) => setProviderDraft((prev) => ({ ...prev, localLlmEndpoint: e.target.value }))}
              placeholder="http://127.0.0.1:11434/v1/chat/completions"
            />
          </label>

          <label className="field">
            <span>Local LLM Model</span>
            <input
              type="text"
              value={providerDraft.localLlmModel}
              onChange={(e) => setProviderDraft((prev) => ({ ...prev, localLlmModel: e.target.value }))}
              placeholder="llama3.1:8b"
            />
          </label>

          {providerSaveStatus && <div className="warning">{providerSaveStatus}</div>}
        </div>
      </div>
    );
  }

  if (view === 'template-settings') {
    return (
      <div className={`app ${transitionClass}`}>
        {renderResizeHandles()}
        <div className="title-row" onPointerDown={(event) => void handleTitlePointerDown(event)}>
          <strong>Template Settings</strong>
          <div className="title-actions">
            <div className="controls">
              <button className="tiny" onClick={() => setView('key-settings')}>
                Key Settings
              </button>
              <button
                className="tiny"
                onClick={async () => {
                  await savePromptTemplates(templateDrafts);
                  setTemplates(templateDrafts);
                  setView('editor');
                }}
              >
                Save
              </button>
              <button
                className="tiny"
                onClick={() => {
                  setTemplateDrafts(templates);
                  setView('editor');
                }}
              >
                Back
              </button>
            </div>
            {renderWindowControls()}
          </div>
        </div>

        <div className="settings-grid">
          <div className="template-box">
            <div className="template-head">
              <strong>Prompt Templates (직군)</strong>
              <div className="controls">
                <button
                  className="tiny"
                  onClick={() => {
                    setTemplateDrafts((prev) => [...prev, createTemplate()]);
                  }}
                >
                  Add
                </button>
              </div>
            </div>

            {templateDrafts.length === 0 ? (
              <div className="history-empty">템플릿이 없습니다. Add로 생성하세요.</div>
            ) : (
              <div className="template-card-list">
                {templateDrafts.map((tpl) => (
                  <div key={tpl.id} className="template-card">
                    <div className="template-card-head">
                      <strong>{tpl.name || '새 템플릿'}</strong>
                      <button className="tiny danger" onClick={() => deleteTemplateById(tpl.id)}>
                        Delete
                      </button>
                    </div>
                    <label className="field">
                      <span>직군 이름</span>
                      <input
                        type="text"
                        value={tpl.name}
                        onChange={(e) => updateTemplateById(tpl.id, { name: e.target.value })}
                        placeholder="예: 개발자, 변호사"
                      />
                    </label>
                    <label className="field">
                      <span>지침 템플릿</span>
                      <textarea
                        className="template-textarea"
                        value={tpl.instruction}
                        onChange={(e) => updateTemplateById(tpl.id, { instruction: e.target.value })}
                        placeholder="이 직군 스타일로 답변하도록 지침을 작성하세요"
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${transitionClass}`}>
      {renderResizeHandles()}
      <div className="title-row" onPointerDown={(event) => void handleTitlePointerDown(event)}>
        <div>
          <strong>Prompt Autocomplete</strong>
          <span className="subtitle"> Ctrl+Space to toggle</span>
        </div>
        <div className="title-actions">
          <div className="badges">
            <span className="badge">Provider: {providerLabel(activeProvider)}</span>
            <span className="badge">Template: {selectedTemplate?.name ?? '없음'}</span>
            {sensitive && cloudProvider && <span className="badge warn">Sensitive input: cloud provider disabled</span>}
            {loading && <span className="badge">thinking...</span>}
          </div>
          {renderWindowControls()}
        </div>
      </div>

      <div className="toolbar">
        <div className="controls">
          <label className="toggle">
            Provider
            <select
              value={providerSettings.selectedProvider}
              onChange={async (event) => {
                const next = { ...providerSettings, selectedProvider: event.target.value as ProviderId };
                setProviderSettings(next);
                setProviderDraft(next);
                await saveProviderSettings(next);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
            </select>
          </label>

          <label className="toggle">
            Template
            <select
              value={settings.selectedTemplateId}
              onChange={(event) => setSettings((prev) => ({ ...prev, selectedTemplateId: event.target.value }))}
            >
              <option value="">없음</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          </label>

          <button
            className="tiny"
            onClick={() => {
              setProviderDraft(providerSettings);
              setTemplateDrafts(templates);
              setView('key-settings');
            }}
          >
            Key Settings
          </button>
          <button
            className="tiny"
            onClick={() => {
              setTemplateDrafts(templates);
              setView('template-settings');
            }}
          >
            Template Settings
          </button>
        </div>
      </div>

      <div className="editor-shell" onClick={() => textareaRef.current?.focus()}>
        <pre className="mirror">
          <span style={{ transform: `translate(${-scrollLeft}px, ${-scrollTop}px)`, display: 'inline-block', width: '100%' }}>
            <span className="typed">{text}</span>
            <span className="ghost">{ghostText}</span>
            {'\u200b'}
          </span>
        </pre>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            // Show a quick local inline immediately for perceived latency.
            const quickInline = next.trim() ? quickInlineContinuation(next) : '';
            setSuggestions((prev) => ({ ...prev, inline: quickInline }));
            maybeRetriggerByWordLength(next);
          }}
          onKeyDown={(event) => void handleKeyDown(event)}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            setScrollLeft(event.currentTarget.scrollLeft);
          }}
          spellCheck={false}
          placeholder="Type your prompt..."
          rows={8}
        />
      </div>

      <div className="toolbar">
        <div className="chips">
          {suggestions.chips.map((chip) => (
            <button key={chip} className="chip" onClick={() => setText((prev) => `${prev} ${chip}`.trimStart())}>
              {chip}
            </button>
          ))}
        </div>
        <div className="controls">
          <button className="tiny" onClick={() => setShowHistory((prev) => !prev)}>
            History
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.hideOnBlur}
              onChange={(event) => setSettings((prev) => ({ ...prev, hideOnBlur: event.target.checked }))}
            />
            Compact on blur
          </label>
        </div>
      </div>

      {showHistory && (
        <div className="history-panel">
          <input
            className="history-search"
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.target.value)}
            placeholder="Search history..."
          />
          <div className="history-list">
            {filteredHistory.map((item) => (
              <button
                key={item.id}
                className="history-item"
                onClick={() => {
                  setText(item.text);
                  setShowHistory(false);
                }}
              >
                {item.text}
              </button>
            ))}
            {filteredHistory.length === 0 && <div className="history-empty">No history</div>}
          </div>
        </div>
      )}

      <div className="suggestion-list">
        {MODES.map((mode, index) => {
          const selected = selectedModeIndex === index;
          const value = suggestions[mode] || '(empty)';
          return (
            <button key={mode} className={`suggestion ${selected ? 'selected' : ''}`} onClick={() => setSelectedModeIndex(index)}>
              <div className="suggestion-head">{modeLabel(mode)}</div>
              <div className="suggestion-body">{value}</div>
            </button>
          );
        })}
      </div>

      <div className="footer">
        <span>Tab: inline accept</span>
        <span>Alt+Right: next word</span>
        <span>Ctrl+J/K: cycle</span>
        <span>Enter: apply rewrite/variant</span>
        <span>Ctrl+Enter: copy + hide</span>
      </div>

      {warning && (
        <div className="warning">
          <span>{warning}</span>
          {providerDisconnected && (
            <button className="tiny" onClick={() => void retryProviderRequest()}>
              재시도
            </button>
          )}
        </div>
      )}
    </div>
  );
}
