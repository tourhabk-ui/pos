/**
 * 1500 на проде упала с 23514: CHECK из 722 не пускал withdrawn / not_confirmed.
 * Файл не попал в _migrations; раннер не сверяет контрольные суммы — правим
 * 1500 так, чтобы CHECK расширялся до UPDATE.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const M1500 = readFileSync(join(ROOT, 'migrations/1500_cuks_phones_official_labels.sql'), 'utf8');

describe('миграция 1500 — CHECK до UPDATE', () => {
  it('расширяет оба CHECK значениями, которые ставит UPDATE', () => {
    expect(M1500).toMatch(/chk_emergency_contacts_source/);
    expect(M1500).toMatch(/'withdrawn'/);
    expect(M1500).toMatch(/chk_emergency_contacts_purpose/);
    expect(M1500).toMatch(/'not_confirmed'/);
  });

  it('сначала меняет CHECK, потом пишет withdrawn / not_confirmed', () => {
    const sourcePos = M1500.indexOf('chk_emergency_contacts_source');
    const purposePos = M1500.indexOf('chk_emergency_contacts_purpose');
    const withdrawnUpdate = M1500.indexOf("source = 'withdrawn'");
    expect(sourcePos).toBeGreaterThan(0);
    expect(purposePos).toBeGreaterThan(0);
    expect(withdrawnUpdate).toBeGreaterThan(purposePos);
    expect(withdrawnUpdate).toBeGreaterThan(sourcePos);
  });

  it('не оставляет отдельную 1501: 1500 должна пройти сама', () => {
    expect(existsSync(join(ROOT, 'migrations/1501_cuks_phones_check_and_retry.sql'))).toBe(false);
  });

  it('сохраняет правки подписей ЦУКС и FAQ', () => {
    expect(M1500).toContain('Старший оперативный дежурный ЦУКС МЧС');
    expect(M1500).toContain('+7 (4152) 200-112');
    expect(M1500).toContain('Начальник дежурной смены ЦУКС');
    expect(M1500).toMatch(/answer LIKE '%30-10-91%'/);
  });
});
