/**
 * /api/requests/stay-chat — переписка гостя с хозяином жилья на странице
 * заявки (1348, #2843).
 *
 *   GET  ?k=<ключ статуса>      — сообщения заявки, подключён ли MAX гостя,
 *                                 ссылка подключить MAX;
 *   POST { k, text }            — сообщение гостя хозяину.
 *
 * AUTH: публичный (префикс `/api/requests` в реестре
 * lib/auth/public-api-routes, GET и POST); доступ — по ключу статуса заявки на
 * жильё (1238), который получили только гость и, если заявку оставил помощник
 * через MCP, этот помощник. Частота — по IP, и сообщений гостя по заявке за
 * сутки не больше `STAY_CHAT_GUEST_DAILY_LIMIT` (защита хозяина от потока).
 *
 * ПД: в ответе — автор, текст и время сообщений, название объекта и даты. Имени
 * и телефона гостя нет (человек их знает), адресов чатов нет. Ключ в запросе
 * сюда — осознанно, как у /api/requests/status: страница держит его во
 * фрагменте адреса, в метрику просмотров он не попадает.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { readStayChat, stayRequestIdByKey, postGuestMessage } from '@/lib/stay/stay-chat-service';
import { STAY_CHAT_MAX_LEN, STAY_CHAT_TEXT, stayGuestBotLink } from '@/lib/stay/stay-chat';
import { maxBot } from '@/lib/partners/channel-link';

export const dynamic = 'force-dynamic';

const readLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const KEY_TEXT: Record<'bad_key' | 'not_found' | 'unavailable', { status: number; error: string }> = {
  bad_key: { status: 400, error: 'Ссылка на заявку повреждена — откройте её целиком.' },
  not_found: { status: 404, error: 'Заявка по этой ссылке не найдена или ссылка истекла.' },
  unavailable: { status: 503, error: 'Не удалось прочитать переписку — попробуйте через минуту.' },
};

export async function GET(req: NextRequest) {
  if (!readLimiter.check(getTrustedClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }
  const k = req.nextUrl.searchParams.get('k') ?? '';
  const r = await readStayChat(k);
  if (r.outcome !== 'ok') {
    const t = KEY_TEXT[r.outcome];
    return NextResponse.json({ success: false, error: t.error }, { status: t.status });
  }
  return NextResponse.json({
    success: true,
    data: {
      accommodation: r.facts.accommodationName,
      check_in: r.facts.checkIn,
      check_out: r.facts.checkOut,
      guests: r.facts.guests,
      guest_on_max: r.guestBound,
      owner_on_max: r.ownerOnMax,
      max_link: r.guestBound ? null : stayGuestBotLink(maxBot(), k.trim()),
      messages: r.messages,
    },
  });
}

const PostSchema = z.object({
  k: z.string().trim().min(1, 'Нет ключа заявки'),
  text: z.string().max(STAY_CHAT_MAX_LEN + 200, `Сообщение длиннее ${STAY_CHAT_MAX_LEN} знаков`),
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
  const id = await stayRequestIdByKey(parsed.data.k);
  if (id.outcome !== 'ok') {
    const t = KEY_TEXT[id.outcome];
    return NextResponse.json({ success: false, error: t.error }, { status: t.status });
  }
  const r = await postGuestMessage(id.id, parsed.data.text, 'page');
  switch (r.outcome) {
    case 'sent':
      return NextResponse.json({ success: true, data: { delivery: r.delivery } });
    case 'bad_text':
      return NextResponse.json({ success: false, error: r.error ?? 'Сообщение не принято' }, { status: 400 });
    case 'daily_limit':
      return NextResponse.json({ success: false, error: STAY_CHAT_TEXT.dailyLimit }, { status: 429 });
    case 'not_found':
      return NextResponse.json({ success: false, error: KEY_TEXT.not_found.error }, { status: 404 });
    default:
      return NextResponse.json({ success: false, error: 'Сообщение не записалось — попробуйте через минуту.' }, { status: 503 });
  }
}
