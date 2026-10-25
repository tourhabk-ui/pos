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
import { visitorHash, currentDay, ipHash } from '@/lib/analytics/visitor-hash';
import { isSelfVisit } from '@/lib/analytics/self-visit';
import { isStaffOwnVisit } from '@/lib/analytics/staff-visit';
import { isPlatformBoxIp } from '@/lib/analytics/box-ip';
import { classifyPageHit } from '@/lib/analytics/visit-class';
import { classifyAddressBurst, ENGAGED_DWELL_MS } from '@/lib/analytics/address-burst';
import { kamchatkaDayBounds } from '@/lib/analytics/kamchatka-day';
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
  const trustedIp = getTrustedClientIpOrNull(req.headers);
  const classified = classifyPageHit({
    userAgent,
    webdriver: parsed.data.webdriver === true,
    clientBeacon: parsed.data.beacon === true,
    own: isSelfVisit(req.headers.get('cookie'))
      || await isStaffOwnVisit(cookie)
      || isPlatformBoxIp(trustedIp),
  });
  let isBot = classified.isBot;
  const isSelf = classified.isSelf;
  let audience = classified.audience;

  // Суточный хэш адреса — отдельно от visitor_hash (тот мешает адрес с UA).
  // Нет доверенного адреса — NULL, а не 127.0.0.1: запасной адрес лимита
  // склеил бы всех без заголовка в один «адрес».
  const bounds = kamchatkaDayBounds();
  const salt = process.env.CRON_SECRET ?? 'vedar';
  const addressHash = trustedIp ? ipHash(trustedIp, bounds.day, salt) : null;
  const stats = addressHash ? await addressDayStats(addressHash, bounds.start, bounds.end, sessionId ?? null) : null;
  const address = stats
    ? classifyAddressBurst({
        isBot,
        isSelf,
        priorHits: stats.hits,
        priorInteraction: stats.interaction,
        fromPath,
      })
    : null;
  let anomaly = false;
  if (address?.anomaly) {
    isBot = true;
    audience = 'bot';
    anomaly = true;
  }

  // Класс устройства (mobile / tablet / desktop) — не сам UA (152-ФЗ).
  // Боту класс не пишем: иначе автопроверка с компьютера попадает в «компьютер».
  const device = isBot ? null : deviceClass(userAgent);
  const base = [path, referrer ?? null, hash, sessionId ?? null, fromPath ?? null, isBot, notFound === true, isSelf];

  let res = await pool.query<{ id: string }>(
    `INSERT INTO page_views (path, referrer, visitor_hash, session_id, from_path, is_bot, is_not_found, is_self, device, ua_family, client_beacon, ip_hash, anomaly_bot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [...base, device, classified.family, parsed.data.beacon === true, addressHash, anomaly],
  ).catch((e: { code?: string; message?: string }) => {
    if (e?.code === '42703') return undefined;
    console.error('[analytics/hit] запись не удалась:', e?.code ?? 'нет SQLSTATE', (e?.message ?? '').slice(0, 200));
    return null;
  });
  // Колонки появляются по одной миграции. Нет ip_hash — пишем класс
  // просмотра как раньше. Нет и его — прежним составом. is_bot и is_self
  // уже выставлены, «люди» не раздуваются.
  if (res === undefined) {
    res = await pool.query<{ id: string }>(
      `INSERT INTO page_views (path, referrer, visitor_hash, session_id, from_path, is_bot, is_not_found, is_self, device, ua_family, client_beacon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [...base, device, classified.family, parsed.data.beacon === true],
    ).catch((e: { code?: string; message?: string }) => {
      if (e?.code === '42703') return undefined;
      console.error('[analytics/hit] запись без хэша адреса не удалась:', e?.code ?? 'нет SQLSTATE', (e?.message ?? '').slice(0, 200));
      return null;
    });
  }
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

  // Всплеск метит строки адреса, у визита которых нет взаимодействия;
  // взаимодействие снимает метку только своего визита. Короткое время на
  // странице трекер шлёт сам при уходе — это не взаимодействие.
  // Бота по адресу браузера (is_bot без anomaly_bot) и свой заход не трогает
  // ни то, ни другое.
  const reclass = res && addressHash ? address?.reclass ?? null : null;
  const releaseSession = reclass === 'release' ? sessionId ?? null : null;
  if (reclass === 'burst' || releaseSession) {
    const sql = reclass === 'burst'
      ? `UPDATE page_views AS p
            SET is_bot = TRUE, anomaly_bot = TRUE
          WHERE p.ip_hash = $1
            AND NOT p.is_self
            AND NOT p.is_bot
            AND p.created_at >= $2
            AND p.created_at < $3
            AND p.from_path IS NULL
            AND (p.dwell_ms IS NULL OR p.dwell_ms < $4)
            AND NOT EXISTS (
              SELECT 1 FROM page_views AS seen
               WHERE seen.ip_hash = p.ip_hash
                 AND seen.session_id = p.session_id
                 AND seen.created_at >= $2
                 AND seen.created_at < $3
                 AND (seen.from_path IS NOT NULL OR seen.dwell_ms >= $4)
            )`
      : `UPDATE page_views
            SET is_bot = FALSE, anomaly_bot = FALSE
          WHERE ip_hash = $1
            AND anomaly_bot
            AND NOT is_self
            AND created_at >= $2
            AND created_at < $3
            AND session_id = $4`;
    const params = reclass === 'burst'
      ? [addressHash, bounds.start, bounds.end, ENGAGED_DWELL_MS]
      : [addressHash, bounds.start, bounds.end, releaseSession];
    await pool.query(sql, params).catch((e: { code?: string }) => {
      if (e?.code === '42703') return;
      console.error('[analytics/hit] метка адреса не обновлена:', e?.code ?? 'нет SQLSTATE');
    });
  }

  return NextResponse.json({ ok: true, id: res?.rows[0]?.id ?? null, audience });
}

function sqlState(e: unknown): string {
  if (typeof e === 'object' && e && 'code' in e && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return 'нет SQLSTATE';
}

/**
 * Сколько просмотров этого адреса уже лежит в камчатских сутках и было ли
 * взаимодействие в ЭТОМ визите. Без sessionId визит — одна новая строка,
 * прежнего взаимодействия у неё нет. null — колонки ещё нет или запрос не
 * выполнился: порог не выдумываем.
 */
async function addressDayStats(
  hash: string,
  start: Date,
  end: Date,
  session: string | null,
): Promise<{ hits: number; interaction: boolean } | null> {
  try {
    const res = await pool.query<{ hits: number | string; interaction: unknown }>(
      `SELECT COUNT(*)::int AS hits,
              COALESCE(bool_or(session_id = $4 AND (from_path IS NOT NULL OR dwell_ms >= $5)), FALSE) AS interaction
         FROM page_views
        WHERE ip_hash = $1
          AND created_at >= $2
          AND created_at < $3`,
      [hash, start, end, session, ENGAGED_DWELL_MS],
    );
    const hits = Number(res.rows[0]?.hits);
    if (!Number.isFinite(hits)) return null;
    const interaction = res.rows[0]?.interaction;
    return { hits, interaction: interaction === true || interaction === 't' || interaction === 'true' };
  } catch (e) {
    const code = sqlState(e);
    if (code !== '42703') console.error('[analytics/hit] сутки адреса не прочитаны:', code);
    return null;
  }
}
