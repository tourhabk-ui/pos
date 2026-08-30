/**
 * Поиск places по имени независимо от видимости/слияния — только чтение.
 *
 * Публичный /api/search намеренно прячет скрытые и слитые записи; этот
 * роут — единственный способ ответить на «место правда не заведено или
 * оно скрыто», не имея прямого доступа к базе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/cron/place-audit/route.ts'),
  'utf-8',
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('только чтение под секретом', () => {
  it('ничего не пишет', () => {
    expect(CODE).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });
  it('закрыт CRON_SECRET', () => {
    expect(CODE).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});

describe('видит то, что публичный поиск прячет', () => {
  it('не фильтрует по is_visible', () => {
    expect(CODE).not.toMatch(/is_visible = true/i);
  });
  it('не фильтрует по merged_into_id IS NULL — наоборот, объясняет, во что слито', () => {
    expect(CODE).not.toMatch(/merged_into_id IS NULL/);
    expect(CODE).toMatch(/merged_into_name/);
  });
  it('отдаёт профиль безопасности для ручной сверки после слияния', () => {
    expect(CODE).toMatch(/location_safety_profile/);
  });
});
