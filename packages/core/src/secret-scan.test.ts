// Covers: T12, T18
import { describe, expect, it } from 'vitest';
import { redactText, redactValue, scanText, scanValue } from './secret-scan.js';

// Built at runtime so this file itself never contains a complete fake credential.
const fake = (...parts: string[]) => parts.join('');

describe('secret scan', () => {
  it.each([
    [
      'private_key',
      fake('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'),
    ],
    ['aws_access_key', fake('AKIA', 'IOSFODNN7EXAMPLE')],
    ['aws_secret_key', fake('aws_secret_access_key=', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')],
    [
      'aws_secret_key',
      fake('aws_secret_access_key = "', 'Zr8KqP2vTnW5yX9bC3dF6gH1jL4mN7pQ0sR2tU5v', '"'),
    ],
    ['aws_secret_key', fake('AWS_SECRET_ACCESS_KEY: ', 'Zr8KqP2vTnW5yX9bC3dF6gH1jL4mN7pQ0sR2tU5v')],
    ['url_credentials', fake('DATABASE_URL=postgres://admin:', 'S3cretPass@db.internal:5432/app')],
    ['url_credentials', fake('https://deploy:', 'hunter2@registry.example.com/v2')],
    ['github_token', fake('ghp_', 'a'.repeat(36))],
    ['anthropic_key', fake('sk-ant-', 'api03-', 'b'.repeat(40))],
    ['openai_key', fake('sk-proj-', 'c'.repeat(40))],
    ['slack_token', fake('xoxb-', '1234567890-abcdef')],
    ['stripe_key', fake('sk_live_', 'd'.repeat(24))],
    ['google_api_key', fake('AIza', 'e'.repeat(35))],
    ['npm_token', fake('npm_', 'f'.repeat(36))],
    ['jwt', fake('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NSJ9', '.abcdefghijk')],
    ['pearcoder_invitation', fake('pc1_', 'g'.repeat(60), '.', 'h'.repeat(60))],
    ['credential_assignment', 'DATABASE_PASSWORD=hunter2hunter2'],
    ['credential_assignment', '"api_key": "abcdef123456789"'],
    ['local_path', '/Users/halil/projects/x'],
    ['local_path', 'C:\\Users\\halil\\repo\\file.ts'],
  ])('finds %s', (kind, text) => {
    const findings = scanText(`before ${text} after`);
    expect(findings.map((f) => f.kind)).toContain(kind);
    expect(findings[0]?.preview).not.toContain(text.slice(6, -2));
  });

  it('ignores ordinary prose, placeholders and env references', () => {
    expect(
      scanText(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell-style env reference is the input under test
        'Refresh tokens rotate on use. Set API_KEY=${API_KEY} or password: <your password>. See src/token.ts:3.',
      ),
    ).toEqual([]);
  });

  it('redacts the whole secret, not just a neighbouring key (QA regression)', () => {
    const text = [
      fake('aws_access_key_id=', 'AKIA', 'IOSFODNN7EXAMPLE'),
      fake('aws_secret_access_key=', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'),
      fake('DATABASE_URL=postgres://admin:', 'S3cretPass@db.internal:5432/app'),
    ].join('\n');
    const redacted = redactText(text);
    expect(redacted).not.toContain('IOSFODNN7EXAMPLE');
    expect(redacted).not.toContain('wJalrXUtnFEMI');
    expect(redacted).not.toContain('S3cretPass');
    expect(scanText(redacted)).toEqual([]);
  });

  it('leaves URLs without credentials alone', () => {
    expect(
      scanText('see https://github.com/acme/auth/pull/7 and postgres://db.internal:5432/app'),
    ).toEqual([]);
  });

  it('reports the JSON path of findings inside structured values', () => {
    const findings = scanValue({ body: 'ok', excerpts: [{ text: fake('ghp_', 'z'.repeat(36)) }] });
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'github_token', field: 'excerpts[0].text' }),
    ]);
  });

  it('redacts findings in text and nested values', () => {
    expect(redactText(`token ghp_${'q'.repeat(36)} in /Users/halil/x`)).toBe(
      'token [redacted github token] in [redacted local path]/x',
    );
    const redacted = redactValue({ a: ['AKIA' + 'IOSFODNN7EXAMPLE'], n: 3 });
    expect(redacted).toEqual({ a: ['[redacted aws access key]'], n: 3 });
  });
});
