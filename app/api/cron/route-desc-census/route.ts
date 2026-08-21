/**
 * GET /api/cron/route-desc-census — где описание маршрута спорит с его же
 * записью (кампания владельца 21.08: описания в массе переписаны AI, выдумка
 * уже дважды находилась — «долина Паратунки» у Озерков на Пиначевке,
 * generic-тексты бывших «Зимних сказок»).
 *
 * Судья — lib/routes/desc-facts.ts. Четыре рода находок:
 *   - числа текста против чисел записи (км / часы / набор высоты);
 *   - упомянутое место реестра в ≥30 км от координаты маршрута;
 *   - обещание трека/GPS при отсутствии линии;
 *   - совет сойти с тропы (advisesLeavingTrail — тот же гвард, что у постов).
 *
 * Перепись только СРАВНИВАЕТ: чинить текст или запись — решение человека,
 * как в переписи имён. READ-ONLY, Bearer CRON_SECRET, offset/limit — окно.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import {
  parseClaimedNumbers,
  compareFacts,
  mentionedFarPlaces,
  claimsTrack,
  type DescFinding,
  type PlaceRef,
} from '@/lib/routes/desc-facts';
import { advisesLeavingTrail } from '@/lib/notifications/post-validation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const rawOffset = parseInt(sp.get('offset') ?? '0', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const rawLimit = parseInt(sp.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 40;

  try {
    const { rows } = await pool.query<{
      id: string; title: string; description: string | null;
      lat: string | null; lng: string | null;
      distance_km: string | null; duration_hours: string | null;
      elevation_gain_m: number | null; has_line: boolean;
    }>(
      `SELECT r.id::text AS id, r.title, r.description,
              r.lat::text AS lat, r.lng::text AS lng,
              r.distance_km::text AS distance_km,
              r.duration_hours::text AS duration_hours,
              r.elevation_gain_m,
              (r.geometry IS NOT NULL) AS has_line
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
       ORDER BY r.title`,
    );

    // Реестр живых мест с координатами — для проверки чужой географии.
    const placesRes = await pool.query<{ name: string; lat: string; lng: string }>(
      `SELECT name, lat::text AS lat, lng::text AS lng FROM places
       WHERE is_visible = true AND merged_into_id IS NULL
         AND lat IS NOT NULL AND lng IS NOT NULL`,
    );
    const places: PlaceRef[] = placesRes.rows.map(p => ({
      name: p.name, lat: Number(p.lat), lng: Number(p.lng),
    }));

    let withDescription = 0;
    const offenders: Array<{
      id: string; title: string; findings: DescFinding[];
      description_head: string | null;
    }> = [];

    for (const r of rows) {
      const desc = r.description?.trim() ?? '';
      if (desc.length === 0) continue;
      withDescription++;

      const findings: DescFinding[] = [];
      findings.push(...compareFacts(parseClaimedNumbers(desc), {
        distanceKm: r.distance_km === null ? null : Number(r.distance_km),
        durationH: r.duration_hours === null ? null : Number(r.duration_hours),
        gainM: r.elevation_gain_m,
      }));
      findings.push(...mentionedFarPlaces(
        desc,
        r.lat === null ? null : Number(r.lat),
        r.lng === null ? null : Number(r.lng),
        r.title,
        places,
      ));
      if (!r.has_line && claimsTrack(desc)) {
        findings.push({
          kind: 'track_claim_no_line',
          detail: 'описание говорит о треке/GPS, а линии у маршрута нет',
        });
      }
      if (advisesLeavingTrail(desc)) {
        findings.push({
          kind: 'leaves_trail',
          detail: 'описание советует сойти с тропы',
        });
      }

      if (findings.length > 0) {
        offenders.push({
          id: r.id,
          title: r.title,
          findings,
          description_head: desc.slice(0, 240),
        });
      }
    }

    const byKind: Record<string, number> = {};
    for (const o of offenders) {
      for (const f of o.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    }

    return NextResponse.json({
      success: true,
      probe: 'route_desc_census_v1',
      live_total: rows.length,
      with_description: withDescription,
      offenders_total: offenders.length,
      by_kind: byKind,
      window: { offset, limit },
      items: offenders.slice(offset, offset + limit),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи описаний';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
