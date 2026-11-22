/**
 * 1500 на проде упала из-за CHECK (23514). 1501 расширяет ограничение
 * и повторяет правки; сам файл 1500 не переписывается.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const M1500 = readFileSync(join(ROOT, 'migrations/1500_cuks_phones_official_labels.sql'), 'utf8');
const M1501 = readFileSync(join(ROOT, 'migrations/1501_cuks_phones_check_and_retry.sql'), 'utf8');

describe('миграция 1501 — повтор после 23514', () => {
  it('1500 по-прежнему ставит withdrawn / not_confirmed (файл не переписан)', () => {
    expect(M1500).toMatch(/source = 'withdrawn'/);
    expect(M1500).toMatch(/purpose = 'not_confirmed'/);
  });

  it('1501 расширяет оба CHECK до этих значений', () => {
    expect(M1501).toMatch(/chk_emergency_contacts_source/);
    expect(M1501).toMatch(/'withdrawn'/);
    expect(M1501).toMatch(/chk_emergency_contacts_purpose/);
    expect(M1501).toMatch(/'not_confirmed'/);
  });

  it('1501 повторяет правки подписей ЦУКС и FAQ', () => {
    expect(M1501).toContain('Старший оперативный дежурный ЦУКС МЧС');
    expect(M1501).toContain('+7 (4152) 200-112');
    expect(M1501).toContain('Начальник дежурной смены ЦУКС');
    expect(M1501).toMatch(/answer LIKE '%30-10-91%'/);
  });
});
