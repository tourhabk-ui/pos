/**
 * POST /api/widget/event — маяк открытия окна виджета партнёра.
 *
 * AUTH: публичный by design — его шлёт скрипт на чужом сайте у посетителя
 * без сессии (покрыт префиксом '/api/widget' в lib/auth/public-api-routes).
 *
 * ── Повод (аудит 15.10, находка WID-measure, W6) ──────────────────────────
 *
 * Скрипты виджета (public/widget/embed.js и /api/widget/lead.js) на сайте
 * партнёра не сообщали ничего: «пользуются ли виджетом» узнать было нечем.
 * Теперь по первому клику по кнопке на странице скрипт шлёт сюда
 * `navigator.sendBeacon` с телом text/plain (простой запрос — без preflight,
 * ответ скрипту не нужен):
 *
 *   {"partner":"<slug>","kind":"open","widget":"form"|"chat","host":"<hostname>"}
 *
 * Больше ничего — схема строгая, лишний ключ отвергается: ни телефона, ни
 * текста, ни пути страницы здесь быть не может. IP и User-Agent не пишутся;
 * адрес нужен только ограничителю частоты в памяти.
 *
 * Маяк шлёт страница ПАРТНЁРА, а не iframe: внутри окна виджета нет ни
 * Метрики, ни service worker (lib/embed/widget-frame.ts, сторож
 * widget-frame-clean), и маяк их туда не приносит.
 *
 * Хост присылает браузер — подделывается кем угодно. Это сигнал для счёта, а
 * не замок: ничего по нему не открывается и не закрывается.
 *
 * Запись не ждётся и ответ не роняет: 204 уходит сразу, отказ записи — в лог
 * с SQLSTATE (lib/embed/widget-telemetry.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { isBotUserAgent } from '@/lib/analytics/bot-detect';
import { normalizeWidgetHost } from '@/lib/embed/widget-origin';
import { recordWidgetOpened } from '@/lib/embed/widget-telemetry';

export const dynamic = 'force-dynamic';

/** Тело маяка — не больше пары сотен байт; больше — не наш скрипт. */
const MAX_BODY = 1024;

const eventLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

const WidgetEventSchema = z.object({
  partner: z.string().regex(/^[\w-]{1,100}$/, 'Некорректный партнёр'),
  kind: z.literal('open'),
  widget: z.enum(['form', 'chat']),
  host: z.string().max(253).nullish(),
}).strict();

export async function POST(request: NextRequest) {
  const ip = getTrustedClientIp(request.headers);
  if (!eventLimiter.check(ip)) {
    return new NextResponse(null, { status: 429 });
  }

  const raw = await request.text().catch((err: unknown) => {
    console.error('[widget-event] тело маяка не прочитано:', err instanceof Error ? err.message : String(err));
    return null;
  });
  if (raw === null || raw.length > MAX_BODY) {
    return NextResponse.json({ success: false, error: 'Некорректный маяк' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ success: false, error: 'Маяк не в формате JSON' }, { status: 400 });
  }
  const parsed = WidgetEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректный маяк' },
      { status: 400 },
    );
  }

  // Краулер, исполнивший скрипт и «кликнувший», — не посетитель партнёра.
  if (isBotUserAgent(request.headers.get('user-agent'))) {
    return new NextResponse(null, { status: 204 });
  }

  const { partner, widget, host } = parsed.data;
  void recordWidgetOpened(pool, partner, normalizeWidgetHost(host), widget);
  return new NextResponse(null, { status: 204 });
}
