/**
 * /api/cron/route-web-null — снять паутинную СИНТЕТИКУ с живых маршрутов.
 *
 * Паутина — линия, у которой один сегмент перелетает десятки километров:
 * по такой не идут, а витрина рисует её как геометрию маршрута. Перепись
 * (`web-routes-census`, проба 87) нашла на живой витрине одну — «Вулкан
 * Зимина», прыжок 25.5 км, источник waypoints_synthetic. Решение владельца
 * 20.08: обнулять.
 *
 * Обнуление — не потеря данных, а снятие лжи: синтетика построена прямыми
 * между путевыми точками (миграция 168), сами точки остаются в
 * route_waypoints, и линию можно перестроить в любой момент. Снятые треки
 * этот актуатор НЕ трогает по построению: критерий требует источник из
 * SYNTHETIC_SOURCES — и в выборке, и в самом UPDATE.
 *
 * Кандидатов считает сервер тем же правилом, что перепись (прыжок >
 * порога), — клиент id не присылает и прислать не может: список, собранный
 * руками, разошёлся бы с переписью. Потолок партии защищает от сюрприза:
 * ожидается одна запись; если критерий вдруг находит больше MAX_NULL,
 * прогон отказывается целиком — это повод смотреть данные, а не жать
 * сильнее.
 *
 * GET — кандидаты (read-only). POST { dry_run } — обнуление; dry_run по
 * умолчанию true. Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { maxSegmentKm } from '@/lib/routes/geometry-compact';
import { SYNTHETIC_SOURCES } from '@/lib/map/line-standard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Тот же порог, что у переписи web-routes-census: правило одно. */
const JUMP_KM = 25;
/** Больше этого за прогон не обнуляем — критерий, нашедший толпу, подозрителен сам. */
const MAX_NULL = 5;

interface WebCandidate {
  id: string;
  title: string;
  jumpKm: number;
  vertices: number;
  source: string;
}

async function findCandidates(): Promise<{ scanned: number; candidates: WebCandidate[] }> {
  const { rows } = await pool.query<{
    id: string; title: string; coordinates: unknown; source: string;
  }>(
    `SELECT r.id::text AS id, r.title,
            r.geometry->'coordinates' AS coordinates,
            r.geometry->>'source' AS source
     FROM kamchatka_routes r
     WHERE r.is_visible = true
       AND r.merged_into_id IS NULL
       AND r.geometry->>'type' = 'LineString'
       AND r.geometry->>'source' = ANY($1)`,
    [[...SYNTHETIC_SOURCES]],
  );

  const candidates: WebCandidate[] = [];
  for (const r of rows) {
    const raw = Array.isArray(r.coordinates) ? r.coordinates : [];
    // GeoJSON хранит [lng, lat], детектор ждёт [lat, lng].
    const coords = raw
      .filter((c): c is number[] => Array.isArray(c) && c.length >= 2)
      .map(c => [c[1], c[0]] as [number, number]);
    if (coords.length < 2) continue;
    const jump = Math.round(maxSegmentKm(coords) * 10) / 10;
    if (jump > JUMP_KM) {
      candidates.push({ id: r.id, title: r.title, jumpKm: jump, vertices: coords.length, source: r.source });
    }
  }
  candidates.sort((a, b) => b.jumpKm - a.jumpKm);
  return { scanned: rows.length, candidates };
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { scanned, candidates } = await findCandidates();
    return NextResponse.json({
      success: true,
      probe: 'web_null_v1',
      jump_threshold_km: JUMP_KM,
      synthetic_scanned: scanned,
      candidates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка поиска паутинной синтетики';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
});

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  try {
    const { scanned, candidates } = await findCandidates();

    if (candidates.length > MAX_NULL) {
      return NextResponse.json({
        success: false,
        error: `критерий нашёл ${candidates.length} записей при потолке ${MAX_NULL} — прогон остановлен, смотреть данные`,
        candidates,
      }, { status: 400 });
    }

    if (data.dry_run || candidates.length === 0) {
      return NextResponse.json({
        success: true,
        dry_run: true,
        synthetic_scanned: scanned,
        would_null: candidates.length,
        candidates,
      });
    }

    // Источник перепроверяется и в UPDATE: даже если между выборкой и
    // записью геометрию сменили на снятую, снятый трек не обнулится.
    const { rows } = await pool.query<{ id: string; title: string }>(
      `UPDATE kamchatka_routes
       SET geometry = NULL, updated_at = NOW()
       WHERE id::text = ANY($1)
         AND geometry->>'source' = ANY($2)
       RETURNING id::text AS id, title`,
      [candidates.map(c => c.id), [...SYNTHETIC_SOURCES]],
    );

    return NextResponse.json({
      success: true,
      dry_run: false,
      synthetic_scanned: scanned,
      nulled: rows.length,
      routes: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка обнуления паутинной синтетики';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
