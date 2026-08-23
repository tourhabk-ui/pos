/**
 * POST /api/cron/place-coords — исправить координату МЕСТА.
 *
 * Отдельный роут, а не поле в общей правилке: координата — единственное,
 * чем место отвечает на вопрос «где я». Описание можно переписать, имя
 * поправить, а сдвинутая координата ведёт человека в другое место, и на
 * Камчатке это не опечатка, а сотни километров по бездорожью.
 *
 * Повод (23.08). Улики подсказчика связей показали место «Большие
 * Тюшевские термальные источники» на 54.6029/156.2038 — в Охотском море,
 * западнее полуострова, — при том что одноимённый маршрут стоит на
 * 54.6389/161.3064, и внешний справочник кладёт источники в шести
 * километрах от маршрута. Врало место. Соседняя запись, «Малые
 * Тюшевские», врёт так же: 155.8048 вместо 161.2457.
 *
 * Правила:
 *   - поимённо: id места, новая координата и ПРИЧИНА к каждой правке;
 *   - source обязателен и общий на партию — откуда взята правда. Без
 *     него правка неотличима от выдумки, а через месяц не проверить,
 *     чему верить (§4.0);
 *   - dry_run по умолчанию: сначала план со старой и новой координатой и
 *     расстоянием сдвига, потом запись;
 *   - боевая партия не больше 10 (правило владельца «лучше по 10»);
 *   - старая координата возвращается в ответе — это и есть откат;
 *   - конверт края — грубый фильтр от 0/0 и перепутанных широты с
 *     долготой. Ошибку Тюшевских он НЕ ловит: 156.2 лежит внутри
 *     конверта, просто в море. Конверт отсекает бессмыслицу, а не
 *     неправду, и выдавать его за проверку правды нельзя.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { distanceKm } from '@/lib/routes/place-link';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Грубый конверт Камчатского края с Курилами и Командорами. */
export const KRAI_LAT_MIN = 50.0;
export const KRAI_LAT_MAX = 65.5;
export const KRAI_LNG_MIN = 155.0;
export const KRAI_LNG_MAX = 174.0;

const LIVE_BATCH_MAX = 10;

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  source: z.string().min(8, 'source обязателен: откуда взята правда').max(300),
  fixes: z.array(z.object({
    place: z.string().min(8).max(64),
    lat: z.number(),
    lng: z.number(),
    why: z.string().min(8, 'у каждой правки обязана быть причина').max(300),
  })).min(1).max(50),
});

interface PlaceRow {
  given: string;
  id: string | null; name: string | null;
  lat: number | null; lng: number | null;
}

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

  if (!data.dry_run && data.fixes.length > LIVE_BATCH_MAX) {
    return NextResponse.json({
      success: false,
      error: `боевая партия не больше ${LIVE_BATCH_MAX} правок (получено ${data.fixes.length}) — сухой прогон без ограничения`,
    }, { status: 400 });
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of data.fixes) {
    if (seen.has(f.place)) problems.push(`${f.place}: место повторяется в списке`);
    seen.add(f.place);
    if (f.lat < KRAI_LAT_MIN || f.lat > KRAI_LAT_MAX) {
      problems.push(`${f.place}: широта ${f.lat} вне края (${KRAI_LAT_MIN}..${KRAI_LAT_MAX})`);
    }
    if (f.lng < KRAI_LNG_MIN || f.lng > KRAI_LNG_MAX) {
      problems.push(`${f.place}: долгота ${f.lng} вне края (${KRAI_LNG_MIN}..${KRAI_LNG_MAX})`);
    }
  }

  try {
    const { rows } = await pool.query<PlaceRow>(
      `SELECT t.given AS given, p.id::text AS id, p.name, p.lat, p.lng
         FROM unnest($1::text[]) AS t(given)
         LEFT JOIN places p
           ON p.id::text = t.given AND p.is_visible = true AND p.merged_into_id IS NULL`,
      [data.fixes.map(f => f.place)],
    );

    const byId = new Map(rows.map(r => [r.given, r]));
    interface PlanItem {
      placeId: string; name: string;
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      movedKm: number; why: string;
    }
    const plan: PlanItem[] = [];

    for (const f of data.fixes) {
      const r = byId.get(f.place);
      if (!r || !r.id) { problems.push(`${f.place}: живого места с таким id нет`); continue; }
      const oldLat = Number(r.lat);
      const oldLng = Number(r.lng);
      const moved = Math.round(distanceKm(oldLat, oldLng, f.lat, f.lng) * 10) / 10;
      if (moved === 0) {
        problems.push(`${f.place}: координата уже такая — править нечего`);
        continue;
      }
      plan.push({
        placeId: r.id, name: r.name ?? '',
        from: { lat: oldLat, lng: oldLng },
        to: { lat: f.lat, lng: f.lng },
        movedKm: moved, why: f.why,
      });
    }

    if (problems.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Правки не прошли проверку — не изменено ничего', problems },
        { status: 400 },
      );
    }

    if (data.dry_run) {
      return NextResponse.json({
        success: true, probe: 'place_coords_v1', dry_run: true,
        source: data.source, fixes_total: plan.length, plan,
      });
    }

    const applied: PlanItem[] = [];
    for (const p of plan) {
      // eslint-disable-next-line no-await-in-loop
      const res = await pool.query(
        `UPDATE places
            SET lat = $2, lng = $3, updated_at = NOW()
          WHERE id::text = $1 AND is_visible = true AND merged_into_id IS NULL`,
        [p.placeId, p.to.lat, p.to.lng],
      );
      if ((res.rowCount ?? 0) > 0) applied.push(p);
      else problems.push(`${p.placeId}: строка не обновилась`);
    }

    return NextResponse.json({
      success: true, probe: 'place_coords_v1', dry_run: false,
      source: data.source,
      applied_count: applied.length,
      // Старая координата — это и есть откат: вернуть её тем же запросом.
      applied,
      problems: problems.length > 0 ? problems : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка правки координат';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
