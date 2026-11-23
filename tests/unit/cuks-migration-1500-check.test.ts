/**
 * 1500 на проде упала с 23514: CHECK из 722 не пускал withdrawn / not_confirmed.
 * Файл не попал в _migrations; раннер не сверяет контрольные суммы — правим
 * 1500 так, чтобы CHECK расширялся до UPDATE. Сторож судит сам SQL, а не
 * вхождения в комментариях.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const M1500 = readFileSync(join(ROOT, 'migrations/1500_cuks_phones_official_labels.sql'), 'utf8');

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');
}

/** Список значений в ADD CONSTRAINT <name> CHECK (… IN (…)). */
function checkInList(sql: string, constraint: string): string[] | null {
  sql = stripSqlComments(sql);
  const re = new RegExp(
    String.raw`ADD CONSTRAINT\s+${constraint}\s+CHECK\s*\([\s\S]*?\bIN\s*\(([^)]*)\)`,
    'i',
  );
  const m = sql.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** DROP IF EXISTS стоит до ADD, и оба — до UPDATE на withdrawn. */
function dropThenAddBeforeWithdrawnUpdate(sql: string, constraint: string): boolean {
  sql = stripSqlComments(sql);
  const drop = sql.search(new RegExp(String.raw`DROP CONSTRAINT IF EXISTS\s+${constraint}\b`, 'i'));
  const add = sql.search(new RegExp(String.raw`ADD CONSTRAINT\s+${constraint}\b`, 'i'));
  const upd = sql.search(/source\s*=\s*'withdrawn'/);
  return drop >= 0 && add >= 0 && upd >= 0 && drop < add && add < upd;
}

describe('разбор SQL миграции 1500 (контроль на испорченной копии)', () => {
  it('без значения в IN (...) проверка краснеет', () => {
    const broken = M1500.replace(
      /chk_emergency_contacts_source\s+CHECK\s*\([\s\S]*?IN\s*\([^)]*\)/i,
      "chk_emergency_contacts_source CHECK (source IS NULL OR source IN ('code', 'visitkamchatka', 'seed', 'verified'))",
    );
    expect(checkInList(broken, 'chk_emergency_contacts_source')).not.toContain('withdrawn');
  });

  it('без DROP CONSTRAINT IF EXISTS проверка краснеет', () => {
    const broken = M1500.replace(
      /ALTER TABLE emergency_contacts DROP CONSTRAINT IF EXISTS chk_emergency_contacts_source;\n/i,
      '',
    );
    expect(dropThenAddBeforeWithdrawnUpdate(broken, 'chk_emergency_contacts_source')).toBe(false);
  });
});

describe('миграция 1500 — CHECK до UPDATE', () => {
  it('ADD CONSTRAINT source включает withdrawn в список IN, не только в комментарии', () => {
    const list = checkInList(M1500, 'chk_emergency_contacts_source');
    expect(list, 'нет ADD CONSTRAINT chk_emergency_contacts_source с IN (...)').not.toBeNull();
    expect(list).toContain('withdrawn');
    expect(list).toContain('verified');
  });

  it('ADD CONSTRAINT purpose включает not_confirmed в список IN', () => {
    const list = checkInList(M1500, 'chk_emergency_contacts_purpose');
    expect(list, 'нет ADD CONSTRAINT chk_emergency_contacts_purpose с IN (...)').not.toBeNull();
    expect(list).toContain('not_confirmed');
    expect(list).toContain('emergency');
  });

  it('каждый констрейнт сначала снимается IF EXISTS, потом ставится, и только потом UPDATE', () => {
    expect(dropThenAddBeforeWithdrawnUpdate(M1500, 'chk_emergency_contacts_source')).toBe(true);
    expect(dropThenAddBeforeWithdrawnUpdate(M1500, 'chk_emergency_contacts_purpose')).toBe(true);
  });

  it('сохраняет правки подписей ЦУКС и FAQ', () => {
    expect(M1500).toContain('Старший оперативный дежурный ЦУКС МЧС');
    expect(M1500).toContain('+7 (4152) 200-112');
    expect(M1500).toContain('Начальник дежурной смены ЦУКС');
    expect(M1500).toMatch(/answer LIKE '%30-10-91%'/);
  });
});
