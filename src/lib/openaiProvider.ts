import { invoke } from '@tauri-apps/api/core';
import type { ProviderId, SuggestionProvider, SuggestionResponse } from '../types';

export class UnifiedProvider implements SuggestionProvider {
  async generate(
    input: string,
    locale: string,
    provider: ProviderId,
    templateContext: string
  ): Promise<SuggestionResponse> {
    return invoke<SuggestionResponse>('generate_suggestions', {
      text: input,
      mode: 'all',
      locale,
      provider,
      templateContext
    });
  }
}
