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

  it('?detail=true отдаёт тексты pending-черновиков для ручной сверки, тоже только SELECT', () => {
    const getBody = SRC.slice(SRC.indexOf('export async function GET'), SRC.indexOf('export async function POST'));
    expect(getBody).toContain("searchParams.get('detail') === 'true'");
    expect(getBody).toMatch(/SELECT d\.place_id, p\.name AS place_name, d\.original_text, d\.translated_text, d\.model/);
    expect(getBody).toContain("d.status = 'pending'");
    expect(getBody).not.toMatch(/UPDATE|INSERT INTO|DELETE FROM/);
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

  it('?place_ids= ограничивает прогон точечно (12.09: правка реестра без повторной траты AI на верные черновики)', () => {
    const postBody = SRC.slice(SRC.indexOf('export async function POST'));
    expect(postBody).toContain("searchParams.get('place_ids')");
    expect(postBody).toContain('runGvpRemarksDrafts({ dryRun, placeIds })');
  });
});
