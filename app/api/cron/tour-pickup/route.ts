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
 * СВОЕЙ ЗАПИСИ В ТУР ЗДЕСЬ НЕТ (слово владельца 23.11: «Автоматы … пишут в
 * туры только через очередь проверки, своих обходных путей у них нет»).
 * Точка сбора уходит дверью правки (lib/tours/photos-door): у тура на сайте
 * она ждёт проверки администратора, и до одобрения карточка показывает
 * прежнее.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { proposeTourPickup } from '@/lib/tours/photos-door';

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
    return NextResponse.json({ probe: 'tour_pickup_v2', error: msg }, { status: 400 });
  }

  const results: Array<Record<string, unknown>> = [];

  try {
    for (const item of parsed.items) {
      const r = await proposeTourPickup(String(item.id), item.pickup, { dryRun: parsed.dry_run });
      if (r.status === 'not_found') {
        // «Тура нет» — это отказ по строке, а не молчаливый пропуск.
        results.push({ id: item.id, status: 'not_found' });
        continue;
      }
      results.push({
        id: item.id, title: r.title, status: r.status,
        // Прежнее значение (витрина плюс правка на проверке) — это откат.
        // Возвращается всегда, в том числе null: «было пусто» надо уметь
        // вернуть так же, как «было вот это».
        was: r.was, now: r.now, why: item.why,
      });
    }

    const count = (status: string) => results.filter((r) => r.status === status).length;
    return NextResponse.json({
      probe: 'tour_pickup_v2',
      dry_run: parsed.dry_run,
      source: parsed.source,
      asked: parsed.items.length,
      // На сайте этих правок ещё нет: они ждут проверки администратора.
      staged_for_review: count('staged'),
      // Туры, которых туристы не видят: записано в строку.
      written_not_on_site: count('written'),
      skipped_owner_pending: count('skipped_owner_pending'),
      nothing_new: count('nothing_new'),
      not_found: count('not_found'),
      // Разобрано ноль при ненулевом входе — отказ, а не успех.
      meaningful: results.some((r) => r.status !== 'not_found'),
      results,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    console.error('[tour-pickup] правка не удалась:', msg);
    return NextResponse.json({ probe: 'tour_pickup_v2', error: msg, results }, { status: 500 });
  }
}
