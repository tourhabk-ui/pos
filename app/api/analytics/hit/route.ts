/**
 * POST /api/analytics/hit
 * Публичный endpoint для трекинга просмотров страниц.
 * Вызывается клиентским компонентом PageViewTracker.
 *
 * Возвращает id записи: клиент досылает по нему время на странице
 * (POST /api/analytics/dwell) в момент ухода. Без этого «поведение» свелось бы
 * к факту захода, а вопрос «где человек застрял и где ушёл» остался бы без
 * ответа.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { isBotUserAgent } from '@/lib/analytics/bot-detect';

const HitSchema = z.object({
  path:      z.string().min(1).max(500),
  referrer:  z.string().max(500).optional(),
  /** Случайный id визита из sessionStorage: живёт до закрытия вкладки. */
  sessionId: z.string().min(8).max(64).optional(),
  /** Предыдущий путь в этом же визите — ребро карты переходов. */
  fromPath:  z.string().max(500).optional(),
  /** Заход на несуществующий адрес: ошибка поведения, а не просто просмотр. */
  notFound:  z.boolean().optional(),
});

const hitLimiter = createRateLimiter({ windowMs: 10_000, max: 20 });

export async function POST(req: NextRequest) {
  // Базовая защита от флуда (ботов она не отсекает — для них ниже is_bot)
  const ip = getClientIp(req.headers);
  if (!hitLimiter.check(ip)) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false }, { status: 400 }); }

  const parsed = HitSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });

  const { path, referrer, sessionId, fromPath, notFound } = parsed.data;

  // Не трекаем системные и админские пути
  if (path.startsWith('/api/') || path.startsWith('/_next/') || path.startsWith('/hub/admin')) {
    return NextResponse.json({ ok: true });
  }

  const userAgent = req.headers.get('user-agent') ?? '';

  // Суточный хэш посетителя вместо сырых IP/UA (152-ФЗ) — считаем
  // уникальных за день, длинного профиля не строим by design
  const hash = visitorHash(
    ip,
    userAgent,
    currentDay(),
    process.env.CRON_SECRET ?? 'vedar',
  );

  // Строку бота НЕ выбрасываем, а помечаем: доля не-людей — величина,
  // которую надо видеть, а не прятать.
  const isBot = isBotUserAgent(userAgent);

  const res = await pool.query<{ id: string }>(
    `INSERT INTO page_views (path, referrer, visitor_hash, session_id, from_path, is_bot, is_not_found)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [path, referrer ?? null, hash, sessionId ?? null, fromPath ?? null, isBot, notFound === true],
  ).catch(() => null); // не критично: страница не должна страдать из-за счётчика

  return NextResponse.json({ ok: true, id: res?.rows[0]?.id ?? null });
}
