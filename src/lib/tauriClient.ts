import { invoke } from '@tauri-apps/api/core';
import type { PromptHistoryItem, PromptTemplate, ProviderConnectionTestResult, ProviderId, ProviderSettings } from '../types';

export async function copyAndHide(content: string): Promise<void> {
  await invoke('copy_and_hide', { content });
}

export async function saveHistory(item: PromptHistoryItem): Promise<void> {
  await invoke('save_history_item', { item });
}

export async function loadHistory(): Promise<PromptHistoryItem[]> {
  return invoke<PromptHistoryItem[]>('load_history');
}

export async function setHideOnBlur(enabled: boolean): Promise<void> {
  await invoke('set_hide_on_blur', { enabled });
}

export async function loadGlobalHotkey(): Promise<string> {
  return invoke<string>('load_global_hotkey');
}

export async function setGlobalHotkey(hotkey: string): Promise<string> {
  return invoke<string>('set_global_hotkey', { hotkey });
}

export async function loadProviderSettings(): Promise<ProviderSettings> {
  return invoke<ProviderSettings>('load_provider_settings');
}

export async function saveProviderSettings(settings: ProviderSettings): Promise<void> {
  await invoke('save_provider_settings', { settings });
}

export async function loadPromptTemplates(): Promise<PromptTemplate[]> {
  return invoke<PromptTemplate[]>('load_prompt_templates');
}

export async function savePromptTemplates(templates: PromptTemplate[]): Promise<void> {
  await invoke('save_prompt_templates', { templates });
}

export async function testProviderConnection(provider: ProviderId): Promise<ProviderConnectionTestResult> {
  return invoke<ProviderConnectionTestResult>('test_provider_connection', { provider });
}
