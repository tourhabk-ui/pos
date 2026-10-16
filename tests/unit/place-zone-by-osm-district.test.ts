// @vitest-environment node
/**
 * Район места по муниципальному округу точки — 87 мест (1294, 16.10, #83).
 *
 * Перепись районов по контурам OSM (place-district-census.yml, прогон 1)
 * нашла 120 расхождений района с округом. Сторож судит то, что исполнится:
 * пары из оператора миграции (без комментариев) и блоки по округам — против
 * настоящего разбора приёма (mchs_zones): район, который ставит миграция, —
 * та зона, которую получает тревога МЧС о том же округе. Исключения названы
 * в шапке и проверяются здесь же.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';
import { ALERT_ZONES } from '@/lib/safety/alert-zones';
import { migrationBody } from '../helpers/migration-sql';

const SQL = readFileSync(join(process.cwd(), 'migrations/1294_place_zone_by_osm_district.sql'), 'utf-8');
const SQL_1293 = readFileSync(join(process.cwd(), 'migrations/1293_place_zone_by_district.sql'), 'utf-8');

interface Row { id: string; from: string | null; to: string; district: string }

/** Пары по блокам: заголовок блока — комментарий «-- <округ> (отношение N): …». */
function rows(): Row[] {
  const out: Row[] = [];
  let district = '';
  const values = SQL.split('FROM (VALUES')[1].split(') AS v(id, zone_from, zone_to)')[0];
  for (const line of values.split('\n')) {
    const head = /^\s*-- (.+?) \(отношение \d+\):/.exec(line);
    if (head) { district = head[1]; continue; }
    const m = /^\s*\('([0-9a-f-]{36})', (NULL|'([a-z]+)'), '([a-z]+)'\)/.exec(line);
    if (m) out.push({ id: m[1], from: m[3] ?? null, to: m[4], district });
  }
  return out;
}

const ROWS = rows();
const EXCEPTION_TO_EASTERN = new Set([
  '543b7feb-1d7c-4544-9bb2-01c00da0f619', // Большие Тюшевские
  'de288759-cc39-4ce9-9faf-324d5995baaa', // Малые Тюшевские
  '05112df7-54f9-4280-bcd2-1bfe4929dfc0', // фумарола Дзендзура
]);

describe('1294: район — по округу точки', () => {
  it('87 мест, каждое один раз, и ни одного из 1293', () => {
    expect(ROWS).toHaveLength(87);
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(87);
    for (const r of ROWS) expect(SQL_1293, r.id).not.toContain(r.id);
  });

  it('ставится только тревожная зона из четырёх', () => {
    for (const r of ROWS) expect(ALERT_ZONES, `${r.id} → ${r.to}`).toContain(r.to);
  });

  it('зона — та, что получает тревога МЧС о том же округе (разбор приёма)', () => {
    for (const r of ROWS) {
      if (EXCEPTION_TO_EASTERN.has(r.id) || r.district === 'городской округ Палана') continue;
      expect(mchs_zones(r.district), `${r.district}: ${r.id} → ${r.to}`).toContain(r.to);
    }
  });

  it('исключения названы: восточный берег Елизовского — «восточная», Палана — «северная», как соседи', () => {
    for (const r of ROWS.filter((x) => EXCEPTION_TO_EASTERN.has(x.id))) {
      expect(r.district).toBe('Елизовский район');
      expect(r.to).toBe('eastern');
    }
    const palana = ROWS.filter((r) => r.district === 'городской округ Палана');
    expect(palana.map((r) => r.to)).toEqual(['northern']);
    // Палана — Корякский округ: тревоги о ней находят место по координате.
    expect(mchs_zones('городской округ Палана')).toEqual(['krai_koryak']);
  });

  it('восточную зону миграция не снимает ни с кого — это вопрос владельцу (#2293)', () => {
    expect(ROWS.filter((r) => r.from === 'eastern')).toEqual([]);
    // Елизовский в карте округов остаётся авачинской зоной.
    expect(mchs_zones('Елизовский район')).toEqual(['avachinsky']);
  });

  it('Бакенинг и озёра Тимоновского заказника не тронуты — верховья Авачи', () => {
    for (const id of [
      '073a9803-9a0f-4dee-b448-713cc759b637', '96d1131f-0eac-4088-9973-2e981787e802',
      '34c595d6-6e20-4448-a417-0d1ff792c486', '3d94ebb8-0516-4d0a-9828-2c2b4867cc48',
      '5b8dddd9-854c-4b56-8142-71a3e5c7757f',
    ]) expect(migrationBody(SQL)).not.toContain(id);
  });

  it('правится только прежнее значение, пустое — тоже по сверке', () => {
    expect(SQL).toMatch(/AND p\.zone IS NOT DISTINCT FROM v\.zone_from;/);
    expect(ROWS.filter((r) => r.from === null).map((r) => r.id)).toEqual(['87028371-cf6b-9b01-47f9-6f568b8d856b']);
  });
});
