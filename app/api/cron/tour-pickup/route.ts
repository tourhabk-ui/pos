/**
 * POST /api/cron/tour-pickup — записать, КАК турист попадает на тур.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ РУЧКА. Перепись готовности (channel-readiness) показала: у
 * всех восьми живых туров пуст `meeting_point`. Первый разбор счёл это
 * забывчивостью операторов — неверно: операторы забирают туристов сами, и
 * фиксированной точки сбора у таких туров нет и быть не должно. Пустое поле
 * значит «у нас не записано, как турист попадает на тур».
 *
 * Публиковать такое на чужой витрине нельзя — покупатель обязан знать, ждать
 * его у отеля или добираться самому. Но чинится это ОДНОЙ фразой на
 * оператора: перевозка — свойство оператора, а не отдельной поездки.
 *
 * ПРАВИЛА, ТЕ ЖЕ ЧТО У ПРАВКИ КООРДИНАТ (place-coords):
 * - `source` на партию и `why` к каждой правке обязательны и без умолчаний:
 *   через месяц «кто сказал» восстановить будет неоткуда;
 * - сухой прогон по умолчанию — писать надо попросить вслух;
 * - партия не больше десяти;
 * - прежнее значение возвращается в ответе и служит откатом.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 30;

export const LIVE_BATCH_MAX = 10;

const ItemSchema = z.object({
  id: z.number().int().positive(),
  /** Как турист попадает на тур. Пустую строку не принимаем: она неотличима от «не знаем». */
  pickup: z.string().trim().min(5, 'Опишите, как турист попадает на тур').max(500),
  /** Почему именно так — в историю решений, без умолчания. */
  why: z.string().trim().min(3, 'Назовите причину').max(300),
});

const BodySchema = z.object({
  /** Кто сказал. Без умолчания: «оператор сообщил» и «мы предположили» — разные вещи. */
  source: z.string().trim().min(3, 'Назовите источник').max(200),
  dry_run: z.boolean().default(true),
  items: z.array(ItemSchema).min(1).max(LIVE_BATCH_MAX),
});

export async function POST(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : 'Тело запроса не разобрано';
    // Маркер сборки есть и в отказе: иначе настоящая ошибка неотличима от
    // невыкаченного кода (урок пробы 107).
    return NextResponse.json({ probe: 'tour_pickup_v1', error: msg }, { status: 400 });
  }

  const results: Array<Record<string, unknown>> = [];

  try {
    for (const item of parsed.items) {
      const { rows } = await pool.query<{ id: number; title: string; meeting_point: string | null }>(
        `SELECT id, title, meeting_point FROM operator_tours WHERE id = $1 AND deleted_at IS NULL`,
        [item.id],
      );
      const tour = rows[0];
      if (!tour) {
        // «Тура нет» — это отказ по строке, а не молчаливый пропуск.
        results.push({ id: item.id, status: 'not_found' });
        continue;
      }

      if (parsed.dry_run) {
        results.push({
          id: tour.id, title: tour.title, status: 'would_set',
          was: tour.meeting_point, now: item.pickup, why: item.why,
        });
        continue;
      }

      await pool.query(
        `UPDATE operator_tours SET meeting_point = $1, updated_at = NOW() WHERE id = $2`,
        [item.pickup, tour.id],
      );
      results.push({
        id: tour.id, title: tour.title, status: 'set',
        // Прежнее значение — это откат. Возвращается всегда, в том числе null:
        // «было пусто» надо уметь вернуть так же, как «было вот это».
        was: tour.meeting_point, now: item.pickup, why: item.why,
      });
    }

    const changed = results.filter((r) => r.status === 'set').length;
    return NextResponse.json({
      probe: 'tour_pickup_v1',
      dry_run: parsed.dry_run,
      source: parsed.source,
      asked: parsed.items.length,
      changed,
      not_found: results.filter((r) => r.status === 'not_found').length,
      // Разобрано ноль при ненулевом входе — отказ, а не успех.
      meaningful: results.some((r) => r.status !== 'not_found'),
      results,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    console.error('[tour-pickup] правка не удалась:', msg);
    return NextResponse.json({ probe: 'tour_pickup_v1', error: msg, results }, { status: 500 });
  }
}
