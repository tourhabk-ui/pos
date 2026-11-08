/**
 * Сторож: связи «место — парк» (миграция 1407) — копия проверенных списков
 * «точка в контуре», а не новое утверждение.
 *
 * 08.11 Корякская сопка стояла зелёной при закрытом Налычево: внутри контура
 * её нашла миграция 1248, а правило закрытия (PARK_SCOPED_SQL) контура не
 * читало. 1407 переносит списки миграций парков в place_park_links. Сторож
 * держит перенос честным: каждая связь — из списка своей миграции-источника
 * с тем же парком, ни одной лишней и ни одной потерянной; число в проверке
 * исхода миграции — то же, что в списке; парк — тот, который закрытие умеет
 * назвать (PARK_NAME_PATTERNS). Само правило исполняется на PostgreSQL —
 * tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARK_NAME_PATTERNS } from '@/lib/safety/park-closure';

const MIGRATIONS = join(process.cwd(), 'migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const LINKS = read('1407_place_park_links.sql');

/** Пары (id, имя) из `WITH <cte>(id, name) AS (VALUES …)`, n-я по счёту. */
function cteMembers(file: string, head: string, nth = 0): string[] {
  const src = read(file);
  let at = -1;
  for (let k = 0, from = 0; k <= nth; k++) {
    at = src.indexOf(head, from);
    expect(at, `${file}: нет ${head} №${nth}`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
  const body = src.slice(at, src.indexOf('\n)\n', at));
  return [...body.matchAll(/\('([0-9a-f-]{36})',\s*'(?:[^']|'')*'\)/g)].map((m) => m[1]!);
}

/** id из `WHERE id::text IN ('…', …)`, начиная с названного первого. */
function inListMembers(file: string, firstId: string): string[] {
  const lines = read(file).split('\n');
  const start = lines.findIndex((l) => l.includes(`IN ('${firstId}'`));
  expect(start, `${file}: нет списка с ${firstId}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let k = start; k < lines.length; k++) {
    const code = lines[k]!.split('--')[0]!;
    const id = code.match(UUID)?.[0];
    if (id) out.push(id);
    if (/'\)/.test(code)) break;
  }
  return out;
}

/** Источники: какая миграция какой парк проверила точкой в контуре. */
function expectedLinks(): Array<{ id: string; slug: string; source: string }> {
  const out: Array<{ id: string; slug: string; source: string }> = [];
  const add = (slug: string, source: string, ids: string[]) => ids.forEach((id) => out.push({ id, slug, source }));
  add('nalychevo', '1248', cteMembers('1248_nalychevo_natural_park.sql', 'WITH members(id, name) AS ('));
  add('nalychevo', '1248', cteMembers('1248_nalychevo_natural_park.sql', 'WITH free_zone(id, name) AS ('));
  add('nalychevo', '1289', cteMembers('1289_eco_zone_by_oopt_contours.sql', 'WITH members(id, name) AS (', 2));
  add('bystrinskiy', '1246', cteMembers('1246_bystrinsky_natural_park.sql', 'WITH members(id, name) AS ('));
  // 1245: сорок мест «Ключевского», за ними семь «Южно-Камчатского» (шапка 1245).
  const k1245 = cteMembers('1245_volcanoes_national_park.sql', 'WITH members(id, name) AS (');
  add('klyuchevskoy', '1245', k1245.slice(0, 40));
  add('yuzhno-kamchatsky', '1245', k1245.slice(40));
  add('vilyuchinsky', '1254', inListMembers('1254_vilyuchinsky_natural_park.sql', '164f612c-32da-4f0f-b261-c45c09dc2933'));
  add('kronotsky', '1274', inListMembers('1274_eco_zone_by_contour_ilike_places.sql', '796c18b3-e199-4ac6-bbd6-de50d560ff40'));
  add('kronotsky', '1289', cteMembers('1289_eco_zone_by_oopt_contours.sql', 'WITH members(id, name) AS (', 0));
  add('komandorskiy', '1288', ['d64e3e6a-72a5-4c14-adc0-588c3824f6ae']);
  add('komandorskiy', '1289', cteMembers('1289_eco_zone_by_oopt_contours.sql', 'WITH members(id, name) AS (', 3));
  return out;
}

/** Строки VALUES 1407: id, парк, причина. */
function linkRows(): Array<{ id: string; slug: string; reason: string }> {
  return [...LINKS.matchAll(/^\s+\('([0-9a-f-]{36})',\s*'([a-z-]+)',\s*'((?:[^']|'')+)'\)/gm)]
    .map((m) => ({ id: m[1]!, slug: m[2]!, reason: m[3]! }));
}

describe('1407: связи «место — парк» — копия проверенных списков', () => {
  it('списки источников разобраны: ноль — сломался разбор, а не «мест нет»', () => {
    const exp = expectedLinks();
    expect(exp.length).toBe(127);
    const bySlug: Record<string, number> = {};
    for (const e of exp) bySlug[e.slug] = (bySlug[e.slug] ?? 0) + 1;
    // Налычево — все 25, что 1248 насчитала внутри контура.
    expect(bySlug).toEqual({
      nalychevo: 25, bystrinskiy: 22, klyuchevskoy: 40, 'yuzhno-kamchatsky': 7,
      vilyuchinsky: 4, kronotsky: 26, komandorskiy: 3,
    });
  });

  it('каждая связь — из своего источника с тем же парком, ни лишней, ни потерянной', () => {
    const key = (x: { id: string; slug: string }) => `${x.id}|${x.slug}`;
    const want = new Set(expectedLinks().map(key));
    const got = linkRows();
    expect(new Set(got.map(key))).toEqual(want);
    expect(got.length, 'одна и та же связь дважды').toBe(want.size);
  });

  it('причина у каждой связи называет миграцию-источник', () => {
    const sourceOf = new Map(expectedLinks().map((e) => [`${e.id}|${e.slug}`, e.source]));
    for (const r of linkRows()) {
      const src = sourceOf.get(`${r.id}|${r.slug}`);
      expect(r.reason, `${r.id}: причина без источника`).toContain(`миграция ${src}`);
      expect(r.reason, r.id).toMatch(/контур/);
    }
  });

  it('проверка исхода ждёт те же числа, что в списке', () => {
    const block = LINKS.slice(LINKS.indexOf('DO $$'));
    const expected = Object.fromEntries(
      [...block.matchAll(/\('([a-z-]+)',\s*(\d+)\)/g)].map((m) => [m[1]!, Number(m[2])]),
    );
    const counted: Record<string, number> = {};
    for (const r of linkRows()) counted[r.slug] = (counted[r.slug] ?? 0) + 1;
    expect(expected).toEqual(counted);
  });

  it('парк связи — тот, который сводка о закрытии умеет назвать', () => {
    const nameable = new Set(PARK_NAME_PATTERNS.map((p) => p.slug));
    const slugs = new Set(linkRows().map((r) => r.slug));
    for (const s of slugs) expect(nameable.has(s), `${s}: закрытие этот парк не называет — связь не читается`).toBe(true);
  });
});
