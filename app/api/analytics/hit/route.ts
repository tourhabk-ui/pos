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
import { createRateLimiter, getClientIp, getTrustedClientIpOrNull } from '@/lib/rate-limit';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { isSelfVisit } from '@/lib/analytics/self-visit';
import { isStaffOwnVisit } from '@/lib/analytics/staff-visit';
import { isPlatformBoxIp } from '@/lib/analytics/box-ip';
import { classifyPageHit } from '@/lib/analytics/visit-class';
import { deviceClass } from '@/lib/analytics/visit-sources';

const HitSchema = z.object({
  path:      z.string().min(1).max(500),
  referrer:  z.string().max(500).optional(),
  /** Случайный id визита из sessionStorage: живёт до закрытия вкладки. */
  sessionId: z.string().min(8).max(64).optional(),
  /** Предыдущий путь в этом же визите — ребро карты переходов. */
  fromPath:  z.string().max(500).optional(),
  /** Заход на несуществующий адрес: ошибка поведения, а не просто просмотр. */
  notFound:  z.boolean().optional(),
  /** Маяк PageViewTracker. Нет поля — вызов не из браузера человека. */
  beacon:    z.boolean().optional(),
  /** navigator.webdriver: автоматический браузер сам это сообщает. */
  webdriver: z.boolean().optional(),
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
  const cookie = req.headers.get('cookie');

  // Суточный хэш посетителя вместо сырых IP/UA (152-ФЗ) — считаем
  // уникальных за день, длинного профиля не строим by design
  const hash = visitorHash(
    ip,
    userAgent,
    currentDay(),
    process.env.CRON_SECRET ?? 'vedar',
  );

  // Строку бота и своего НЕ выбрасываем, а помечаем. «Люди» на витрине —
  // audience person: не бот, не ИИ-краулер, не свой, и маяк был.
  // Адрес для «свой» — только если заголовок его назвал. Нет заголовка —
  // не коробка (getClientIp подставил бы 127.0.0.1 всем таким запросам).
  const classified = classifyPageHit({
    userAgent,
    webdriver: parsed.data.webdriver === true,
    clientBeacon: parsed.data.beacon === true,
    own: isSelfVisit(req.headers.get('cookie'))
      || await isStaffOwnVisit(cookie)
      || isPlatformBoxIp(getTrustedClientIpOrNull(req.headers)),
  });
  const isBot = classified.isBot;
  const isSelf = classified.isSelf;

  // Класс устройства (mobile / tablet / desktop) — не сам UA (152-ФЗ).
  // Боту класс не пишем: иначе автопроверка с компьютера попадает в «компьютер».
  const device = isBot ? null : deviceClass(userAgent);
  const base = [path, referrer ?? null, hash, sessionId ?? null, fromPath ?? null, isBot, notFound === true, isSelf];

  let res = await pool.query<{ id: string }>(
    `INSERT INTO page_views (path, referrer, visitor_hash, session_id, from_path, is_bot, is_not_found, is_self, device, ua_family, client_beacon)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [...base, device, classified.family, parsed.data.beacon === true],
  ).catch((e: { code?: string; message?: string }) => {
    if (e?.code === '42703') return undefined;
    console.error('[analytics/hit] запись не удалась:', e?.code ?? 'нет SQLSTATE', (e?.message ?? '').slice(0, 200));
    return null;
  });
  // Колонки device / ua_family / client_beacon ещё нет — пишем прежним
  // составом. is_bot и is_self уже выставлены, «люди» не раздуваются.
  if (res === undefined) {
    res = await pool.query<{ id: string }>(
      `INSERT INTO page_views (path, referrer, visitor_hash, session_id, from_path, is_bot, is_not_found, is_self, device)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [...base, device],
    ).catch((e: { code?: string; message?: string }) => {
      if (e?.code === '42703') return undefined;
      console.error('[analytics/hit] запись без семейства не удалась:', e?.code ?? 'нет SQLSTATE', (e?.message ?? '').slice(0, 200));
      return null;
    });
  }
  if (res === undefined) {
    res = await pool.query<{ id: string }>(
      `INSERT INTO page_views (path, referrer, visitor_hash, session_id, from_path, is_bot, is_not_found, is_self)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      base,
    ).catch((e: { code?: string; message?: string }) => {
      console.error('[analytics/hit] запись прежним составом не удалась:', e?.code ?? 'нет SQLSTATE', (e?.message ?? '').slice(0, 200));
      return null;
    });
  }

  return NextResponse.json({ ok: true, id: res?.rows[0]?.id ?? null, audience: classified.audience });
}
