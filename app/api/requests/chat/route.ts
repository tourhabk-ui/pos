/**
 * /api/requests/chat — переписка клиента с адресатом заявки на странице
 * заявки (1349, 1350): владелец жилья, туроператор, гид, перевозчик, прокат.
 *
 *   GET  ?k=<ключ статуса>      — сообщения заявки, кто адресат, подключён ли
 *                                 MAX клиента, ссылка подключить MAX;
 *   POST { k, text }            — сообщение клиента адресату.
 *
 * AUTH: публичный (префикс `/api/requests` в реестре
 * lib/auth/public-api-routes, GET и POST); доступ — по ключу статуса заявки
 * (1238), который получили только человек и, если заявку оставил помощник
 * через MCP или A2A, этот помощник. Переписку открывает только ключ НОВОЙ
 * заявки (`opens_chat`, 1350): ключ повтора получил бы и тот, кто знает чужой
 * телефон. Частота — по IP, и сообщений клиента по заявке за сутки не больше
 * `REQUEST_CHAT_GUEST_DAILY_LIMIT` (защита адресата от потока).
 *
 * Переписки нет — это не ошибка: GET отвечает `available: false` с причиной
 * (ключ только статусный; заявку ведёт менеджер Ведара), и страница переписку
 * не рисует. Ключа нет или он не той формы — 404 / 400; база не ответила —
 * 503 (§4.0).
 *
 * ПД: в ответе — автор, текст и время сообщений, название заявки, даты, число
 * людей и вывеска адресата. Имени и телефона клиента нет (человек их знает),
 * адресов чатов нет. Ключ в запросе сюда — осознанно, как у
 * /api/requests/status: страница держит его во фрагменте адреса, в метрику
 * просмотров он не попадает.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { readRequestChat, requestTargetByKey, postGuestMessage } from '@/lib/requests/request-chat-service';
import { CHAT_TEXT, REQUEST_CHAT_MAX_LEN, counterpartDative, counterpartLabel, guestBotLink } from '@/lib/requests/request-chat';
import { maxBot } from '@/lib/partners/channel-link';

export const dynamic = 'force-dynamic';

const readLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const KEY_FAIL: Record<'bad_key' | 'not_found' | 'unavailable', { status: number; error: string }> = {
  bad_key: { status: 400, error: 'Ссылка на заявку повреждена — откройте её целиком.' },
  not_found: { status: 404, error: 'Заявка по этой ссылке не найдена или ссылка истекла.' },
  unavailable: { status: 503, error: 'Не удалось прочитать переписку — попробуйте через минуту.' },
};

/** Переписки по ключу нет — словами, что делать. */
const NO_CHAT: Record<'no_chat' | 'no_counterpart', string> = {
  no_chat: 'По этой ссылке видно только состояние заявки — переписки по ней нет. Если вы уже отправляли эту заявку раньше, переписка — по ссылке, выданной в первый раз.',
  no_counterpart: CHAT_TEXT.noCounterpart,
};

export async function GET(req: NextRequest) {
  if (!readLimiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }
  const k = req.nextUrl.searchParams.get('k') ?? '';
  const r = await readRequestChat(k);
  if (r.outcome === 'no_chat' || r.outcome === 'no_counterpart') {
    return NextResponse.json({ success: true, data: { available: false, reason: NO_CHAT[r.outcome] } });
  }
  if (r.outcome !== 'ok') {
    const t = KEY_FAIL[r.outcome];
    return NextResponse.json({ success: false, error: t.error }, { status: t.status });
  }
  return NextResponse.json({
    success: true,
    data: {
      available: true,
      kind: r.facts.target,
      title: r.facts.title,
      dates: r.facts.dates,
      people: r.facts.people,
      counterpart_label: counterpartLabel(r.facts),
      to_label: counterpartDative(r.facts.role),
      guest_on_max: r.guestBound,
      owner_on_max: r.ownerOnMax,
      max_link: r.guestBound ? null : guestBotLink(maxBot(), k.trim()),
      messages: r.messages,
    },
  });
}

const PostSchema = z.object({
  k: z.string().trim().min(1, 'Нет ключа заявки'),
  text: z.string().max(REQUEST_CHAT_MAX_LEN + 200, `Сообщение длиннее ${REQUEST_CHAT_MAX_LEN} знаков`),
});

export async function POST(req: NextRequest) {
  if (!writeLimiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много сообщений подряд — подождите минуту' }, { status: 429 });
  }
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 }); }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  const t = await requestTargetByKey(parsed.data.k);
  if (t.outcome === 'no_chat') {
    return NextResponse.json({ success: false, error: NO_CHAT.no_chat }, { status: 403 });
  }
  if (t.outcome !== 'ok') {
    const f = KEY_FAIL[t.outcome];
    return NextResponse.json({ success: false, error: f.error }, { status: f.status });
  }
  const r = await postGuestMessage(t.target, parsed.data.text, 'page');
  switch (r.outcome) {
    case 'sent':
      // relayed: не дошедшее до адресата получил оператор Ведара (false — и он не получил).
      return NextResponse.json({ success: true, data: { delivery: r.delivery, relayed: r.relayed ?? null } });
    case 'bad_text':
      return NextResponse.json({ success: false, error: r.error ?? 'Сообщение не принято' }, { status: 400 });
    case 'daily_limit':
      return NextResponse.json({ success: false, error: CHAT_TEXT.dailyLimit }, { status: 429 });
    case 'no_counterpart':
      return NextResponse.json({ success: false, error: NO_CHAT.no_counterpart }, { status: 403 });
    case 'not_found':
      return NextResponse.json({ success: false, error: KEY_FAIL.not_found.error }, { status: 404 });
    default:
      return NextResponse.json({ success: false, error: 'Сообщение не записалось — попробуйте через минуту.' }, { status: 503 });
  }
}
