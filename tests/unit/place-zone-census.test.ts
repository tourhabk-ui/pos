// @vitest-environment node
/**
 * Перепись охвата мест тревогами (GET /api/cron/place-zone-census, 15.10, #83).
 *
 * Сам отбор исполняется на PostgreSQL в tests/integration/alert-place-scope.pg
 * (тем же предикатом крона). Здесь — что роут отдаёт и чем спрашивает:
 *  - без секрета — 401;
 *  - пробы собраны настоящими разборами приёма (mchs_zones, METEOALERT_REGIONS),
 *    а не списком зон в самой переписи: иначе она мерила бы своё;
 *  - в отправленном SQL — предикат крона целиком и ни одной записи;
 *  - отказ базы — 500 с SQLSTATE, а не пустая «перепись без мест».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';
import { METEOALERT_REGIONS } from '@/lib/services/safety/meteoalert';
import { summarizeZoneCensus, zoneProbes, type ZoneCensusRow } from '@/lib/places/zone-census';

const sent: Array<{ sql: string; params: unknown[] }> = [];
let fail: { code: string } | null = null;
const ROWS: ZoneCensusRow[] = [
  { id: 'a', name: 'Арка (тест)', lat: 54.94, lng: 166.2, zone: 'commander', location_type: 'rock', has_status: true, reached_by: ['krai_wide', 'meteo_south'] },
  { id: 'm', name: 'Плато (тест)', lat: 52.45, lng: 158.2, zone: 'mutnovsky', location_type: 'plateau', has_status: true, reached_by: [] },
  { id: 'n', name: 'Без реалтайма (тест)', lat: 53.05, lng: 158.6, zone: 'avachinsky', location_type: null, has_status: false, reached_by: [] },
];

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sql: string, params: unknown[]) => {
      sent.push({ sql, params });
      if (fail) throw Object.assign(new Error('отказ'), fail);
      return { rows: ROWS };
    },
  },
}));

beforeEach(() => { sent.length = 0; fail = null; process.env.CRON_SECRET = 'test-secret'; });

async function call(auth = 'Bearer test-secret') {
  const { GET } = await import('@/app/api/cron/place-zone-census/route');
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest('http://localhost/api/cron/place-zone-census', { headers: { authorization: auth } }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('перепись охвата мест тревогами', () => {
  it('без секрета — 401, база не спрошена', async () => {
    expect((await call('Bearer wrong')).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('пробы — из настоящих разборов приёма, предикат — крона, записи нет', async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    const probes = JSON.parse(String(sent[0].params[0])) as Array<{ kind: string; zones: string[] }>;
    expect(probes.find((p) => p.kind === 'krai_wide')?.zones).toEqual(mchs_zones('Штормовое предупреждение по всему краю'));
    expect(probes.find((p) => p.kind === 'meteo_south')?.zones).toEqual([...METEOALERT_REGIONS['96'].zones]);
    expect(probes.find((p) => p.kind === 'meteo_north')?.zones).toEqual([...METEOALERT_REGIONS['95'].zones]);
    expect(sent[0].sql).toContain(ALERT_MATCH_SQL);
    expect(sent[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(body.places).toBe(3);
  });

  it('свод: недосягаемое место названо поимённо, место без реалтайма — отдельно, район вне проб — не тревожный', () => {
    const census = summarizeZoneCensus(ROWS, zoneProbes());
    expect(census.unreached.krai_wide.map((p) => p.id)).toEqual(['m']);
    expect(census.unreached.meteo_north.map((p) => p.id)).toEqual(['a', 'm']);
    expect(census.no_status.map((p) => p.id)).toEqual(['n']);
    expect(census.commander_box.map((p) => p.id)).toEqual(['a']);
    expect(census.by_zone.find((z) => z.zone === 'commander')).toMatchObject({ alert_zone: false, reached: { krai_wide: 1, meteo_south: 1, meteo_north: 0 } });
    expect(census.by_zone.find((z) => z.zone === 'avachinsky')).toMatchObject({ alert_zone: true });
  });

  it('отказ базы — 500 с SQLSTATE, а не пустая перепись', async () => {
    fail = { code: '42P01' };
    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, sqlstate: '42P01' });
  });
});
