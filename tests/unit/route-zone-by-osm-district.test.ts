// @vitest-environment node
/**
 * Своя зона маршрута по округу его точки — 74 маршрута (1296, 16.10, #83),
 * и поправка 1294 — фумарола Дзендзура (1295).
 *
 * Перепись районов (place-district-census.yml, прогон 2) нашла 118 видимых
 * маршрутов без единой зоны: тревога без координаты до них не доходит.
 * Сторож судит то, что исполнится: пары из оператора миграции против
 * настоящего разбора приёма (mchs_zones) — зона маршрута та, что получает
 * тревога МЧС о том же округе. Исключения названы в шапке и проверяются
 * здесь же поимённо.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';
import { ALERT_ZONES } from '@/lib/safety/alert-zones';
import { migrationBody } from '../helpers/migration-sql';

const read = (f: string) => readFileSync(join(process.cwd(), 'migrations', f), 'utf-8');
const SQL = read('1296_route_zone_by_osm_district.sql');
const SQL_1295 = read('1295_place_zone_dzendzur_nalychevo.sql');
const SQL_1294 = read('1294_place_zone_by_osm_district.sql');
const SQL_1248 = read('1248_nalychevo_natural_park.sql');

interface Row { id: string; from: string | null; to: string; district: string; east: boolean }
interface Block { district: string; count: number; rows: number }

/** Пары по блокам: заголовок — «-- <округ> (отношение N): <откуда> → <куда>, <число>». */
function parse(): { rows: Row[]; blocks: Block[] } {
  const rows: Row[] = [];
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let east = false;
  const values = SQL.split('FROM (VALUES')[1].split(') AS v(id, zone_from, zone_to)')[0];
  for (const line of values.split('\n')) {
    const head = /^\s*-- (.+?) \(отношение \d+\): .+? → [a-z]+, (\d+)/.exec(line);
    if (head) {
      cur = { district: head[1], count: Number(head[2]), rows: 0 };
      blocks.push(cur);
      east = /севернее 54°/.test(line);
      continue;
    }
    const m = /^\s*\('([0-9a-f-]{36})', (NULL|'([a-z]+)'), '([a-z]+)'\)/.exec(line);
    if (m && cur) {
      cur.rows++;
      rows.push({ id: m[1], from: m[3] ?? null, to: m[4], district: cur.district, east });
    }
  }
  return { rows, blocks };
}

const { rows: ROWS, blocks: BLOCKS } = parse();

const EAST_OF_ELIZOVSKY = [
  '12b2aa81-6fa4-4342-af67-b0ec35911f82', // Вулкан Карымский
  '4c2d40c3-84e6-4312-92b2-d9e812e054e6', // Кальдера Узон — Долина гейзеров
  '12dfd2bc-19ec-492c-97de-aa4057073091', // Нижне-Семячикские термальные источники
  '807f2f60-a92f-4726-9986-67cfe944a2e8', // Гейзеры Камчатки
  '8b8d271d-b418-4f8c-bf5f-606c59a2b5e1', // Малые Тюшевские
  'a969b291-104a-4437-b204-10a2015d94d1', // Большие Тюшевские
  '7537b33e-6596-4a5a-8d06-e5c0b9a8e25b', // Нижне-Чажминские
];
const ESSO_OWN_AVACHINSKY = [
  '7ebabb24-87c2-46e2-8ac2-41f998071a97', // Вулкан Дыгерен-Оленгендэ
  '50be875e-da68-43ba-95d6-05d30da6f8f8', // Димшиканский кордон
  'cdbfa59a-af0c-4286-ab8f-9e0ffc0e3958', // Каньон Сноубордистов
];

describe('1296: своя зона маршрута — по округу его точки', () => {
  it('74 маршрута, каждый один раз; число в заголовке блока — правда', () => {
    expect(ROWS).toHaveLength(74);
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(74);
    for (const b of BLOCKS) expect(b.rows, `${b.district}: заголовок ${b.count}`).toBe(b.count);
  });

  it('ставится только тревожная зона из четырёх', () => {
    for (const r of ROWS) expect(ALERT_ZONES, `${r.id} → ${r.to}`).toContain(r.to);
  });

  it('зона — та, что получает тревога МЧС о том же округе (разбор приёма)', () => {
    for (const r of ROWS.filter((x) => !x.east)) {
      expect(mchs_zones(r.district), `${r.district}: ${r.id} → ${r.to}`).toContain(r.to);
    }
  });

  it('исключение названо: Елизовский севернее 54° — «восточная», как места-соседи; карта округов её не даёт', () => {
    const east = ROWS.filter((r) => r.east);
    expect(east.map((r) => r.id).sort()).toEqual([...EAST_OF_ELIZOVSKY].sort());
    for (const r of east) {
      expect(r.district).toBe('Елизовский район');
      expect(r.to).toBe('eastern');
      expect(r.from).toBeNull();
    }
    // Восточную зону Елизовскому не добавляли (#2293) — потому исключение
    // и записано поимённо, а не выводится из карты.
    expect(mchs_zones('Елизовский район')).toEqual(['avachinsky']);
  });

  it('прежняя зона снимается только у трёх маршрутов Эссо; у остальных её не было', () => {
    const withFrom = ROWS.filter((r) => r.from !== null);
    expect(withFrom.map((r) => r.id).sort()).toEqual([...ESSO_OWN_AVACHINSKY].sort());
    for (const r of withFrom) {
      expect(r.from).toBe('avachinsky');
      expect(r.to).toBe('western');
      expect(r.district).toBe('Быстринский муниципальный округ');
    }
  });

  it('правится только прежнее значение — выправленное рукой после переписи не трогается', () => {
    expect(SQL).toMatch(/UPDATE kamchatka_routes r[\s\S]*AND r\.zone IS NOT DISTINCT FROM v\.zone_from;/);
  });
});

describe('1295: фумарола Дзендзура — «Авачинская», как весь парк «Налычево»', () => {
  const DZENDZUR = '05112df7-54f9-4280-bcd2-1bfe4929dfc0';
  const ZHUPANOVSKY = '3031409e-4a99-4f07-80dc-0a92e0a06d02';

  it('1294 ставила ей восточную — это и правится', () => {
    expect(SQL_1294).toMatch(new RegExp(`\\('${DZENDZUR}', 'western', 'eastern'\\)`));
  });

  it('фумарола и Жупановский — места одного парка (1248)', () => {
    for (const id of [DZENDZUR, ZHUPANOVSKY]) expect(migrationBody(SQL_1248)).toContain(id);
  });

  it('ставит «Авачинскую» только поверх восточной, одной строке', () => {
    // Комментарий в конце строки (имя места) — не часть оператора.
    const body = migrationBody(SQL_1295).split('\n').map((l) => l.replace(/\s+--\s.*$/, '')).join('\n');
    expect(body).toMatch(new RegExp(
      `UPDATE places\\s+SET zone = 'avachinsky'[^;]*WHERE id::text = '${DZENDZUR}'\\s+AND zone IS NOT DISTINCT FROM 'eastern';`,
    ));
    expect(body.match(/UPDATE /g)).toHaveLength(1);
  });
});
