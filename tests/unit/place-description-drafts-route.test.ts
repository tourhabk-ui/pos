/**
 * /api/cron/place-description-drafts — предлагает черновик, не публикует.
 *
 * #1830: перевод + проверка, НЕ автовставка. Этот роут не имеет права
 * трогать `places.description` напрямую — единственный путь публикации это
 * `PATCH /api/admin/places/[id]/description-draft` (ручное решение админа).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/place-description-drafts/route.ts'), 'utf-8');

describe('place-description-drafts — предлагает, не публикует', () => {
  it('экспортирует только POST', () => {
    expect(SRC).toMatch(/export async function POST/);
    expect(SRC).not.toMatch(/export async function (GET|PUT|PATCH|DELETE)/);
  });

  it('не трогает places.description напрямую', () => {
    expect(SRC).not.toMatch(/UPDATE\s+places\s+SET/i);
  });

  it('нет DELETE ни при каком аргументе', () => {
    expect(SRC).not.toMatch(/DELETE FROM/i);
  });

  it('авторизация — Bearer CRON_SECRET, постоянным временем', () => {
    expect(SRC).toContain('getCronSecret');
    expect(SRC).toContain('timingSafeCompare');
  });

  it('сухой прогон по умолчанию', () => {
    expect(SRC).toMatch(/dryRunParam\s*!==\s*'false'/);
  });

  it('маркер версии для workflow есть', () => {
    expect(SRC).toMatch(/place_description_drafts_v\d+/);
  });
});
