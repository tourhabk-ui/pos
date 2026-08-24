/**
 * POST /api/funnel — публичный маяк ВЗАИМОДЕЙСТВИЙ воронки (Эволюция 3.0, п.5).
 *
 * AUTH: публичный by design — маяк с витрины, у посетителя нет сессии.
 *
 * Здесь только события, которых НЕТ в собственной метрике страниц: просмотры
 * (каталог, карточка тура) уже пишет PageViewTracker → page_views, и объектив
 * scanFunnel читает их оттуда. Первая версия этого роута дублировала просмотры
 * своим маяком — владелец 08.08: «у нас была настроена своя метрика».
 *
 * Шаги — из единого словаря lib/funnel/steps.ts (стратегия 14.08): касание
 * формы брони, анкета и результат планировщика, сохранение/отправка плана,
 * контакт партнёра, регистрация МЧС, офлайн-пакет. Всё это взаимодействия,
 * а не переходы — в page_views их по построению нет.
 *
 * Без PII: тот же суточный visitorHash с секретной солью, что у page_views
 * (152-ФЗ), боты отсекаются тем же bot-detect, флуд — тем же rate-limiter.
 * Дедуп: посетитель+тур чаще раза в час не считается. Сбой — всегда 204:
 * маяк не должен ломать витрину.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { isBotUserAgent } from '@/lib/analytics/bot-detect';
import { FUNNEL_STEPS } from '@/lib/funnel/steps';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  // Шаги — из единого словаря: приёмник не может разойтись с маяком.
  step: z.enum(FUNNEL_STEPS),
  entity_id: z.string().max(64).nullish(),
});

const funnelLimiter = createRateLimiter({ windowMs: 10_000, max: 10 });

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!funnelLimiter.check(ip)) {
    return new NextResponse(null, { status: 429 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат события' }, { status: 400 });
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  // Краулер, трогающий форму, — не воронка; строку не пишем вовсе
  // (в отличие от page_views, где бот-строки нужны для SEO-наблюдений).
  if (isBotUserAgent(userAgent)) return new NextResponse(null, { status: 204 });

  try {
    const hash = visitorHash(ip, userAgent, currentDay(), process.env.CRON_SECRET ?? 'vedar');
    await pool.query(
      // Приведение типов у КАЖДОГО употребления параметра — не украшение.
      // Без него PostgreSQL выводит для $1 два разных типа: в списке SELECT
      // контекста нет и получается text, а в `step = $1` — varchar колонки.
      // Ответ — 42P08 «inconsistent types deduced for parameter $1», то есть
      // запрос не выполнялся НИ РАЗУ с момента заведения таблицы (миграция
      // 839). Пустой catch делал этот отказ невидимым: витрине уходило 204,
      // таблица оставалась пустой, и «никто не трогал форму» звучало как
      // факт о туристах. Проба /api/cron/beacon-check 24.08 назвала SQLSTATE.
      `INSERT INTO funnel_events (step, entity_id, visitor_hash)
       SELECT $1::varchar, $2::text, $3::varchar
        WHERE NOT EXISTS (
          SELECT 1 FROM funnel_events
           WHERE step = $1::varchar
             AND entity_id IS NOT DISTINCT FROM $2::text
             AND visitor_hash = $3::varchar
             AND created_at > NOW() - INTERVAL '60 minutes'
        )`,
      [parsed.step, parsed.entity_id ?? null, hash],
    );
  } catch (err) {
    // Витрине по-прежнему 204: маяк не должен ронять страницу. Но МОЛЧАТЬ
    // нельзя (§4.0). Пустой catch здесь превращал поломку записи в «событий
    // нет»: приёмник отвечал успехом, таблица оставалась пустой, и ноль в
    // счётчике booking_start был неотличим от «никто не трогал форму». Ровно
    // на этом различии стоит решение, что чинить — продукт или код.
    const e = err as { message?: string; code?: string };
    console.error(
      `[funnel] событие «${parsed.step}» не записано:`,
      e?.message ?? 'неизвестная ошибка',
      `SQLSTATE=${e?.code ?? 'нет'}`,
    );
  }

  return new NextResponse(null, { status: 204 });
}
