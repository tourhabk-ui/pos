/**
 * Разведчик описаний (route-desc-read) — строго read-only инструмент
 * кампании сверки: отдаёт полные тексты, ничего не меняя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'app/api/cron/route-desc-read/route.ts'), 'utf-8',
);

describe('route-desc-read — читает, не пишет', () => {
  it('в файле нет пишущего SQL', () => {
    expect(src).not.toMatch(/UPDATE\s|INSERT\s|DELETE\s/);
  });

  it('только GET, под CRON_SECRET', () => {
    expect(src).toContain('export async function GET');
    expect(src).not.toContain('export async function POST');
    expect(src).toContain('timingSafeCompare(secret');
  });

  it('партия id ограничена', () => {
    expect(src).toContain('.slice(0, 25)');
  });

  it('координата чинится местом из реестра — эндпоинт отдаёт place_match живого места', () => {
    expect(src).toMatch(/is_visible = true AND p\.merged_into_id IS NULL[\s\S]{0,400}AS place_match/);
  });
});
