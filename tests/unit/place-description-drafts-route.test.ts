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
  it('экспортирует POST (пишет черновик) и GET (только читает итог)', () => {
    expect(SRC).toMatch(/export async function POST/);
    expect(SRC).toMatch(/export async function GET/);
    expect(SRC).not.toMatch(/export async function (PUT|PATCH|DELETE)/);
  });

  it('GET не запускает перевод и не пишет: только SELECT по своей таблице', () => {
    const getBody = SRC.slice(SRC.indexOf('export async function GET'), SRC.indexOf('export async function POST'));
    expect(getBody).not.toMatch(/UPDATE|INSERT INTO|DELETE FROM/);
    expect(getBody).not.toContain('runGvpRemarksDrafts');
    expect(getBody).toMatch(/SELECT status, COUNT\(\*\)::text AS n\s*\n\s*FROM place_description_drafts/);
    expect(getBody).toContain("WHERE source = 'gvp'");
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
