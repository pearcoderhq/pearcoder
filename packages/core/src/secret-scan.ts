// Finds credentials and private details in text before it is shared with a session (threat
// model T12, T18). Pattern-based: it catches common token formats and obvious assignments, not
// every secret. It is a safety net under human review, never a replacement for it.

export type SecretKind =
  | 'private_key'
  | 'aws_access_key'
  | 'aws_secret_key'
  | 'url_credentials'
  | 'github_token'
  | 'anthropic_key'
  | 'openai_key'
  | 'slack_token'
  | 'stripe_key'
  | 'google_api_key'
  | 'npm_token'
  | 'jwt'
  | 'pearcoder_invitation'
  | 'credential_assignment'
  | 'local_path';

export interface SecretFinding {
  kind: SecretKind;
  /** Where in the scanned value: a JSON path such as `payload.body`, or '' for plain text. */
  field: string;
  start: number;
  end: number;
  /** The match with most characters masked, safe to show in a terminal. */
  preview: string;
}

const PATTERNS: [SecretKind, RegExp][] = [
  [
    'private_key',
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  ],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  // `aws_secret_access_key = …` and similar: 40 base64 characters after the name.
  [
    'aws_secret_key',
    /\b[\w-]*?(?:aws_?secret(?:_?access)?_?key|secret_?access_?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/gi,
  ],
  // Passwords inside URLs, e.g. postgres://admin:S3cret@db:5432/app.
  ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s@/"']+@[^\s"']+/gi],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_key', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['stripe_key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['pearcoder_invitation', /\bpc1_[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}/g],
  [
    'credential_assignment',
    /\b[\w-]*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']?(?!\$\{|<|\*{3})[^\s"',;]{8,}/gi,
  ],
  ['local_path', /(?:\/Users|\/home)\/[A-Za-z0-9._-]+(?=\/)|[A-Za-z]:\\Users\\[^\\\s"']+(?=\\)/g],
];

function mask(match: string): string {
  if (match.length <= 8) return '*'.repeat(match.length);
  return `${match.slice(0, 4)}${'*'.repeat(Math.min(12, match.length - 6))}${match.slice(-2)}`;
}

export function scanText(text: string, field = ''): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      // Patterns overlap (an OpenAI-looking string inside an assignment): keep the first hit.
      if (findings.some((f) => start < f.end && end > f.start)) continue;
      findings.push({ kind, field, start, end, preview: mask(match[0]) });
    }
  }
  return findings.sort((a, b) => a.start - b.start);
}

/** Scans every string inside a JSON-like value. */
export function scanValue(value: unknown, field = ''): SecretFinding[] {
  if (typeof value === 'string') return scanText(value, field);
  if (Array.isArray(value)) return value.flatMap((item, i) => scanValue(item, `${field}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      scanValue(item, field ? `${field}.${key}` : key),
    );
  }
  return [];
}

export function redactText(text: string, field = ''): string {
  let result = '';
  let cursor = 0;
  for (const finding of scanText(text, field)) {
    result += `${text.slice(cursor, finding.start)}[redacted ${finding.kind.replaceAll('_', ' ')}]`;
    cursor = finding.end;
  }
  return result + text.slice(cursor);
}

/** Returns a copy of the value with every finding replaced by a `[redacted …]` marker. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item)]),
    ) as T;
  }
  return value;
}
