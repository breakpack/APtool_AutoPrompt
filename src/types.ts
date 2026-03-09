export type SuggestionMode = 'inline' | 'rewrite' | 'variant';
export type ProviderId = 'mock' | 'openai' | 'gemini' | 'claude' | 'local';

export interface SuggestionResponse {
  inline: string;
  rewrite: string;
  variant: string;
  chips: string[];
  provider?: ProviderId;
  sensitive?: boolean;
  warning?: string;
}

export interface SuggestionProvider {
  generate(input: string, locale: string, provider: ProviderId, templateContext: string): Promise<SuggestionResponse>;
}

export interface AppSettings {
  hideOnBlur: boolean;
  selectedTemplateId: string;
  allowMockFallback: boolean;
  retriggerWordLength: number;
}

export interface ProviderSettings {
  selectedProvider: ProviderId;
  openaiApiKey: string;
  geminiApiKey: string;
  claudeApiKey: string;
  localLlmEndpoint: string;
  localLlmModel: string;
  useEnvOpenai: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  instruction: string;
}

export interface PromptHistoryItem {
  id: string;
  text: string;
  createdAt: string;
}

export interface ProviderConnectionTestResult {
  ok: boolean;
  message: string;
}
