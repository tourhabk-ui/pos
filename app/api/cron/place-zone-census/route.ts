/**
 * GET /api/cron/place-zone-census — до каких мест и маршрутов доходит тревога
 * без своей координаты. Bearer CRON_SECRET, только чтение.
 *
 * ЗАЧЕМ (15.10, #83). Ветер Росгидромета и «по всему краю» МЧС ложатся на
 * место по району `places.zone` или, у Командор и Корякского округа, по
 * координате. Район вне четырёх тревожных зон таких тревог не получает вовсе,
 * и место стоит «зелёным» — проверить его было нечем, а карточка этого не
 * говорит. Сколько таких мест, из репозитория не видно: это факт о данных
 * прода, и перепись называет его поимённо.
 *
 * Пробы — тем же разбором, каким их сохраняет приём: «по всему краю» —
 * mchs_zones, «юг» и «север» Росгидромета — METEOALERT_REGIONS. Предикат —
 * ALERT_MATCH_SQL крона, без копии (lib/places/zone-census.ts).
 *
 * `?rows=places` (16.10) — ещё и строки всех видимых мест (точка и район):
 * их кладёт на контуры муниципальных округов перепись районов на раннере
 * (place-district-census.yml). Тот же запрос, без второго чтения.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { ZONE_CENSUS_SQL, summarizeZoneCensus, zoneProbes, type ZoneCensusRow } from '@/lib/places/zone-census';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const probes = zoneProbes();
  const withPlaceRows = req.nextUrl.searchParams.get('rows') === 'places';
  try {
    const { rows } = await pool.query<ZoneCensusRow>(ZONE_CENSUS_SQL, [JSON.stringify(probes)]);
    return NextResponse.json({
      ok: true,
      checked_at: new Date().toISOString(),
      probes,
      ...summarizeZoneCensus(rows, probes),
      ...(withPlaceRows
        ? {
            place_rows: rows
              .filter((r) => r.target === 'place')
              .map(({ id, name, lat, lng, zone, location_type }) => ({ id, name, lat, lng, zone, location_type })),
          }
        : {}),
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? null;
    console.error('[place-zone-census] перепись не выполнилась', code ?? (err instanceof Error ? err.message : 'ошибка'));
    return NextResponse.json({ ok: false, error: 'Перепись охвата мест не выполнилась', sqlstate: code }, { status: 500 });
  }
}
