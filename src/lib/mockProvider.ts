import type { ProviderId, SuggestionResponse } from '../types';

const INLINE_LIMIT = 180;
const LONG_LIMIT = 1200;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function hasKorean(text: string): boolean {
  return /[가-힣]/.test(text);
}

function detectChips(text: string): string[] {
  const base = hasKorean(text) ? ['짧게', '격식', '불릿'] : ['concise', 'formal', 'bullet'];
  if (text.includes('요약') || /summary/i.test(text)) {
    return [base[0], base[2], hasKorean(text) ? '핵심만' : 'key points'];
  }
  if (text.includes('이메일') || /email/i.test(text)) {
    return [base[1], hasKorean(text) ? '친근하게' : 'friendly', base[0]];
  }
  return base;
}

function buildInline(text: string): string {
  if (!text.trim()) return '';
  const normalized = text.trim();
  if (hasKorean(normalized)) {
    if (normalized.includes('요약')) {
      return ' 핵심 포인트 3개와 실행 항목을 bullet로 정리해줘.';
    }
    return ' 목적, 제약사항, 원하는 출력 형식을 포함해 구체화해줘.';
  }
  if (/summar/i.test(normalized)) {
    return ' Include 3 key takeaways and 2 action items in bullets.';
  }
  return ' Add context, constraints, and the desired output format.';
}

export class MockProvider {
  async generate(
    input: string,
    _locale: string,
    _provider?: ProviderId,
    templateContext?: string
  ): Promise<SuggestionResponse> {
    const inline = clip(buildInline(input), INLINE_LIMIT);
    const content = input.trim() || (hasKorean(input) ? '요청 내용을 작성해줘.' : 'Write the request details.');

    const rewrite = clip(
      hasKorean(input)
        ? [
            `아래 요청을 더 명확하게 작성해줘:`,
            `${content}`,
            templateContext ? `직군 템플릿: ${templateContext}` : '',
            '',
            '요구사항:',
            '- 목표를 한 문장으로 먼저 제시',
            '- 출력 형식(불릿/표/단락)을 명시',
            '- 길이 제한과 톤을 포함'
          ].join('\n')
        : [
            `Rewrite this prompt for clarity:`,
            `${content}`,
            templateContext ? `Role template: ${templateContext}` : '',
            '',
            'Requirements:',
            '- Start with a single-sentence objective',
            '- Specify output format (bullets/table/paragraph)',
            '- Include length and tone constraints'
          ].join('\n'),
      LONG_LIMIT
    );

    const variant = clip(
      hasKorean(input)
        ? `너는 실무 도우미야. 다음 요청을 실행 가능한 단계로 답해줘.\n요청: ${content}\n출력: 1) 핵심 요약 2) 단계별 실행안 3) 주의사항`
        : `You are a practical assistant. Answer this request in actionable steps.\nRequest: ${content}\nOutput: 1) Quick summary 2) Step-by-step plan 3) Risks and caveats`,
      LONG_LIMIT
    );

    return {
      inline,
      rewrite,
      variant,
      chips: detectChips(input),
      provider: 'mock'
    };
  }
}
