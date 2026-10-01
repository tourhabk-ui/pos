/**
 * /.well-known/security.txt (RFC 9116) — разбор публичного аудита 01.10.
 * Обязательные поля Contact и Expires; Expires считается от запроса и не
 * истекает молча; адрес — из реквизитов, не вписан руками.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { securityTxt, SECURITY_TXT_TTL_DAYS } from '@/lib/security/security-txt';
import { REQUISITES } from '@/lib/legal/requisites';

const NOW = new Date('2026-10-01T03:00:00.000Z');
const TXT = securityTxt(NOW, 'https://vedarai.ru/');

describe('security.txt', () => {
  it('Contact — почта поддержки из реквизитов', () => {
    expect(TXT).toContain(`Contact: mailto:${REQUISITES.emailSupport}\n`);
  });

  it('Expires — в будущем, меньше года, в формате RFC 3339 без долей секунды', () => {
    const m = TXT.match(/^Expires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/m);
    expect(m).not.toBeNull();
    const days = (Date.parse(m![1]) - NOW.getTime()) / 86_400_000;
    expect(days).toBe(SECURITY_TXT_TTL_DAYS);
    expect(days).toBeLessThan(365);
  });

  it('Canonical — по общему пути, без двойного слэша', () => {
    expect(TXT).toContain('Canonical: https://vedarai.ru/.well-known/security.txt\n');
  });

  it('отдаётся роутом по общему пути, а не статикой с датой', () => {
    const route = 'app/.well-known/security.txt/route.ts';
    expect(existsSync(route)).toBe(true);
    expect(readFileSync(route, 'utf-8')).toMatch(/securityTxt\(new Date\(\)/);
    expect(existsSync('public/.well-known/security.txt')).toBe(false);
  });
});
