const RULES: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,
  /api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{12,}/i,
  /password\s*[:=]\s*\S+/i,
  /Bearer\s+[A-Za-z0-9._\-]+/i,
  /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/
];

export function containsSensitiveContent(text: string): boolean {
  if (!text.trim()) return false;
  return RULES.some((rule) => rule.test(text));
}
