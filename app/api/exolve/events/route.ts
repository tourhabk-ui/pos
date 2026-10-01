/**
 * POST /api/exolve/events?s=<EXOLVE_WEBHOOK_SECRET> — события SMS от МТС Exolve.
 *
 * Адрес вписывается в кабинете Exolve (настройки номера → URL для SMS-событий).
 * Подписи у событий Exolve нет, поэтому секрет лежит в самом URL — тот же
 * приём, что у вебхука MAX (lib/max/webhook-url.ts): Exolve зовёт ровно тот
 * адрес, что вписан, а чужой секрета не знает. Нет секрета в окружении —
 * не принимаем ничего (fail-closed).
 *
 * Что делает сейчас:
 * - исходящее SMS не доставлено (FAILED, RETRIES_EXCEEDED, PROHIBITED,
 *   UNDERFUNDED) — громко в лог: тревога, которая не дошла, не должна
 *   выглядеть ушедшей;
 * - входящее SMS — только в лог, без текста и с маской номера. Команды
 *   по SMS («вернулся», «+2 ч») НЕ исполняются намеренно: «вернулся»
 *   снимает поиск, и решить, достаточно ли номера отправителя, чтобы ему
 *   верить, должен владелец (docs/safety/WATCH_MANIFEST.md), а не этот роут.
 *
 * Формат события — docs.exolve.ru, SMS API → SMS Events.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { UNDELIVERED, maskPhone, isVerifiedExolveEvent } from '@/lib/notifications/exolve-events';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const EventSchema = z.object({
  message_id: z.union([z.string(), z.number()]).optional(),
  sender: z.string().max(64).optional(),
  receiver: z.string().max(64).optional(),
  direction: z.string().max(64).optional(),
  delivery_status: z.string().max(64).optional(),
  status: z.string().max(64).optional(),
}).passthrough();

export async function POST(req: NextRequest) {
  if (!isVerifiedExolveEvent(req.url)) {
    return NextResponse.json({ error: 'Источник события не подтверждён' }, { status: 403 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Тело события — не JSON' }, { status: 400 });
  }
  const parsed = EventSchema.safeParse(body);
  if (!parsed.success) {
    console.error('[exolve-events] событие не по формату', logText(parsed.error.message, 200));
    return NextResponse.json({ error: 'Событие не по формату' }, { status: 400 });
  }
  const e = parsed.data;
  const id = logText(e.message_id ?? '', 32);

  if (e.direction === 'DIRECTION_INCOMING') {
    console.warn('[exolve-events] входящее SMS не обработано: команды по SMS не включены', { id, from: maskPhone(e.sender) });
    return NextResponse.json({ ok: true, handled: 'incoming_logged' });
  }

  const statuses = [e.delivery_status, e.status].filter((s): s is string => typeof s === 'string');
  const failed = statuses.find((s) => UNDELIVERED.has(s));
  if (failed) {
    console.error('[exolve-events] SMS не доставлено', { id, to: maskPhone(e.receiver), status: logText(failed, 40) });
    return NextResponse.json({ ok: true, handled: 'undelivered_logged' });
  }
  return NextResponse.json({ ok: true, handled: 'status' });
}
