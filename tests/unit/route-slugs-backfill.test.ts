/**
 * Адреса по имени для маршрутов без ЧПУ (миграция 1136, аудит 01.10).
 *
 * То же правило, что 1111 для мест: только видимому и не слитому маршруту,
 * адрес свободен и среди маршрутов, и среди мест (иначе маршрут стал бы
 * двойником места и уводил 308), двое претендентов — не получает никто,
 * идемпотентно. Проверено прогоном на копии схемы: уникальное имя получило
 * адрес, тёзки и скрытый — нет, повтор — UPDATE 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(process.cwd(), 'migrations/1136_route_slugs_backfill.sql'), 'utf-8')
  .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('миграция 1136: ЧПУ маршрутам по правилу 1111', () => {
  it('та же транслитерация, что у 779 и 1111', () => {
    expect(SQL).toMatch(/translit_ru_slug\(r\.title\)/);
  });
  it('только без адреса, видимым и не слитым', () => {
    expect(SQL).toMatch(/WHERE r\.slug IS NULL/);
    expect(SQL).toMatch(/\(r\.is_visible = TRUE OR r\.is_visible IS NULL\)/);
    expect(SQL).toMatch(/r\.merged_into_id IS NULL/);
    expect(SQL).toMatch(/AND r\.slug IS NULL;/);
  });
  it('адрес свободен и среди маршрутов, и среди мест; тёзки не получают никто', () => {
    expect(SQL).toMatch(/NOT EXISTS \(SELECT 1 FROM kamchatka_routes x WHERE x\.slug = c\.base\)/);
    expect(SQL).toMatch(/NOT EXISTS \(SELECT 1 FROM places p WHERE p\.slug = c\.base\)/);
    expect(SQL).toMatch(/\(SELECT count\(\*\) FROM candidates c2 WHERE c2\.base = c\.base\) = 1/);
  });
  it('без числовых суффиксов: они выглядели бы починкой, не будучи ею', () => {
    expect(SQL).not.toMatch(/\|\|\s*'-'\s*\|\|/);
  });
});
