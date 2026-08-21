/**
 * Перепись линий-монстров — read-only и честная мера.
 *
 * Линия, растянутая по всему полуострову, обещает путь, которого нет, и
 * ею же меряется дистанция («142.3 км» на полевом экране у маршрута к
 * скалам). Перепись только считает — правка линии решается человеком по
 * происхождению данных, не по расстоянию.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'app/api/cron/route-geometry-census/route.ts'), 'utf-8',
);

describe('route-geometry-census', () => {
  it('ничего не пишет', () => {
    expect(src).not.toMatch(/UPDATE\s|INSERT\s|DELETE\s/);
  });

  it('только GET под секретом', () => {
    expect(src).toContain('export async function GET');
    expect(src).not.toContain('export async function POST');
    expect(src).toContain('timingSafeCompare(secret');
  });

  it('судит только живые записи', () => {
    expect(src).toMatch(/r\.is_visible = true AND r\.merged_into_id IS NULL/);
  });

  it('род связей считается отдельно — им объясняется размах', () => {
    expect(src).toContain("link_kind = 'nearby'");
    expect(src).toContain("link_kind = 'waypoint'");
  });

  it('именной запрос показывает всё найденное, а не только нарушителей', () => {
    expect(src).toMatch(/q !== ''\s*\?\s*items/);
  });
});

describe('режим дублей — одна линия у разных маршрутов', () => {
  it('подпись линии строится из концов и числа вершин', () => {
    expect(src).toMatch(/JSON\.stringify\(i\.first\)\}\|\$\{JSON\.stringify\(i\.last\)\}\|\$\{i\.vertices\}/);
  });

  it('в выдачу попадают только группы больше одной записи', () => {
    expect(src).toMatch(/filter\(\(\[, g\]\) => g\.length > 1\)/);
  });

  it('линия без вершин не подписывается вовсе', () => {
    expect(src).toMatch(/if \(i\.vertices < 2 \|\| !i\.first \|\| !i\.last\) continue/);
  });
});
