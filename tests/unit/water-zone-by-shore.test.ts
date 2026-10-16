// @vitest-environment node
/**
 * Точки на воде — зона по ближайшему округу суши (1297, 16.10, #83).
 *
 * Перепись районов, прогон 3: у точки вне всех округов — ближайший округ не
 * дальше 15 км. Сторож судит то, что исполнится: пары обоих операторов
 * против настоящего разбора приёма (mchs_zones) по округу из заголовка строки,
 * расстояние до берега не больше радиуса переписи, и точки с округлёнными
 * координатами в миграцию не попали.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';
import { ALERT_ZONES } from '@/lib/safety/alert-zones';
import { NEAR_SHORE_KM } from '@/lib/places/district-census';

const SQL = readFileSync(join(process.cwd(), 'migrations/1297_water_zone_by_nearest_shore.sql'), 'utf-8');

interface Row { table: 'places' | 'kamchatka_routes'; id: string; from: string | null; to: string; district: string; km: number }

function parse(): Row[] {
  const out: Row[] = [];
  for (const stmt of SQL.split(/^UPDATE /m).slice(1)) {
    const table = stmt.startsWith('places') ? 'places' : 'kamchatka_routes';
    let district = '';
    let km = Number.NaN;
    for (const line of stmt.split(') AS v(id, zone_from, zone_to)')[0].split('\n')) {
      const head = /^\s*-- (.+?) \(отношение \d+\), берег ([\d.]+) км$/.exec(line);
      if (head) { district = head[1]; km = Number(head[2]); continue; }
      const m = /^\s*\('([0-9a-f-]{36})', (NULL|'([a-z]+)'), '([a-z]+)'\)/.exec(line);
      if (m) out.push({ table, id: m[1], from: m[3] ?? null, to: m[4], district, km });
    }
  }
  return out;
}

const ROWS = parse();

describe('1297: вода — зона по ближайшему берегу', () => {
  it('два места и пять маршрутов, каждое один раз', () => {
    expect(ROWS.filter((r) => r.table === 'places')).toHaveLength(2);
    expect(ROWS.filter((r) => r.table === 'kamchatka_routes')).toHaveLength(5);
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(7);
  });

  it('зона — та, что получает тревога МЧС об округе берега; берег не дальше радиуса переписи', () => {
    for (const r of ROWS) {
      expect(ALERT_ZONES, `${r.id} → ${r.to}`).toContain(r.to);
      expect(mchs_zones(r.district), `${r.district}: ${r.id}`).toContain(r.to);
      expect(r.km, r.id).toBeLessThanOrEqual(NEAR_SHORE_KM);
    }
  });

  it('ставится только в пустую зону: у воды её не было', () => {
    for (const r of ROWS) expect(r.from, r.id).toBeNull();
    expect(SQL.match(/IS NOT DISTINCT FROM v\.zone_from;/g)).toHaveLength(2);
  });

  it('округлённые координаты и дальний округ не тронуты', () => {
    for (const id of [
      '62367a0d', // Бухта Тихая — 53.1/159.4
      '2e32fa97', // Бухта Тихая (морская прогулка) — 53.1/159.4
      '1ae39392', // Мыс Зеленый — 53/159
      'f33295d4', // Медведи Камчатки — 54/162
      'bfc30c23', // Остров Манджур — Карагинский район
    ]) expect(ROWS.some((r) => r.id.startsWith(id)), id).toBe(false);
  });
});
