import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { verifyAuth } from '@/lib/auth';
import { classifySosOrigin } from '@/lib/safety/sos-origin';

export const dynamic = 'force-dynamic';

// Rate limit: 1 SOS per 10 minutes per IP (in-memory, не блокируем при сбое Redis)
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 10 * 60 * 1000;

const SOSSchema = z.object({
  latitude:       z.number().min(-90).max(90).optional(),
  longitude:      z.number().min(-180).max(180).optional(),
  lat:            z.number().min(-90).max(90).optional(),
  lng:            z.number().min(-180).max(180).optional(),
  accuracy:       z.number().optional(),
  message:        z.string().max(500).optional(),
  emergency_type: z.string().optional(),
  sessionId:      z.string().optional(),
  tourist_name:   z.string().max(120).optional(),
  tourist_phone:  z.string().max(30).optional(),
  // Поля mesh-ретрансляции — проставляются узлом-ретранслятором
  source:         z.enum(['direct', 'mesh_relay']).optional(),
  relayed_by:     z.string().max(64).optional(),
});

function isRateLimited(key: string): boolean {
  const last = rateLimitMap.get(key);
  if (!last) return false;
  return Date.now() - last < RATE_LIMIT_MS;
}

function setRateLimit(key: string): void {
  rateLimitMap.set(key, Date.now());
  // Очищаем устаревшие записи (> 1 часа)
  for (const [k, ts] of rateLimitMap.entries()) {
    if (Date.now() - ts > 60 * 60 * 1000) rateLimitMap.delete(k);
  }
}

/**
 * POST /api/safety/sos
 * Логирование SOS-сигнала от туриста.
 * Публичный endpoint — доступен без авторизации.
 */
export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';
  const userAgent = request.headers.get('user-agent') ?? null;

  // Оптимистичное чтение auth (не блокируем при отсутствии токена)
  const auth = await verifyAuth(request).catch(() => ({
    isAuthenticated: false,
    userId: null,
    role: null,
    email: null,
  }));

  const userId = auth.isAuthenticated ? auth.userId : null;
  const rateLimitKey = userId ?? ip;

  if (isRateLimited(rateLimitKey)) {
    return NextResponse.json(
      { success: false, error: 'SOS уже отправлен. Повторите через 10 минут.' },
      { status: 429 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    // Тело может быть пустым — это допустимо для SOS
    rawBody = {};
  }

  const validationResult = SOSSchema.safeParse(rawBody);
  if (!validationResult.success) {
    return NextResponse.json(
      { success: false, error: validationResult.error.issues[0]?.message || 'Ошибка валидации' },
      { status: 400 }
    );
  }

  const {
    latitude, longitude, lat, lng, accuracy,
    message, emergency_type, sessionId,
    tourist_name, tourist_phone,
    source, relayed_by,
  } = validationResult.data;

  // Принимаем оба соглашения: latitude/longitude и lat/lng
  const finalLat = latitude ?? lat;
  const finalLng = longitude ?? lng;
  const finalSource = source ?? 'direct';

  // Что известно об ИСТОЧНИКЕ сигнала. Приём это не меняет ни в одном
  // случае: сигнал принимается, пишется и уходит в канал одинаково. Меняется
  // только то, что тревога сможет о себе сказать — см. lib/safety/sos-origin.
  const origin = classifySosOrigin({
    userId,
    secFetchSite: request.headers.get('sec-fetch-site'),
    referer: request.headers.get('referer'),
    userAgent,
    source: finalSource,
    sessionId: sessionId ?? null,
    lat: finalLat, lng: finalLng,
    touristName: tourist_name, touristPhone: tourist_phone,
    emergencyType: emergency_type, message,
  });

  // Логируем в БД (source/relayed_by — добавлены миграцией 678).
  //
  // Отказ записи раньше глотался молча, и rate-limit всё равно ставился —
  // то есть неудачная попытка блокировала повтор человеку в беде на 10
  // минут, а ответ ниже всё равно говорил «сигнал получен». Внешний
  // security-аудит владельца 28.08 поймал это как P0: «SOS может сообщить
  // об успехе, когда сигнал не сохранён и не доставлен». Durable-запись —
  // единственный факт, на основании которого Watchdog видит SOS вообще
  // (таймаут >15 мин по sos_events); без строки в таблице сигнал невидим
  // для эскалации, что бы ни ответил этот роут.
  let eventId: string | null = null;
  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO sos_events
         (user_id, session_id, lat, lng, accuracy, ip_address, user_agent,
          message, emergency_type, tourist_name, tourist_phone, source, relayed_by,
          origin_class)
       VALUES ($1,$2,$3,$4,$5,$6::inet,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id::text AS id`,
      [userId, sessionId, finalLat, finalLng, accuracy, ip, userAgent,
       message ?? null, emergency_type ?? null,
       tourist_name ?? null, tourist_phone ?? null,
       finalSource, relayed_by ?? null, origin.klass]
    );
    eventId = inserted.rows[0]?.id ?? null;
    if (eventId) setRateLimit(rateLimitKey);
  } catch (err) {
    // «Не смог записать» — третий исход, не «отказ». Rate-limit НЕ ставим:
    // раз сигнал не лёг в базу, ничто не должно мешать человеку повторить
    // попытку немедленно. Молчание здесь опаснее лишнего повтора (§4.0).
    console.error('[safety/sos] запись сигнала не удалась:', err instanceof Error ? err.message : err);
  }

  // Telegram-уведомление — приоритет: ADMIN, фоллбэк на основной бот-чатид
  // админа. Отправляем НЕЗАВИСИМО от того, легла ли запись: если БД
  // отказала, это единственный оставшийся канал, и молчать тут нельзя.
  // Раньше вызов был fire-and-forget с проглоченной ошибкой — ответ
  // человеку не знал, ушло ли уведомление вообще.
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  let notified = false;
  if (botToken && chatId) {
    const loc = finalLat && finalLng
      ? `${finalLat.toFixed(5)}, ${finalLng.toFixed(5)}`
      : 'нет координат';
    const mapsLink = finalLat && finalLng
      ? `https://www.google.com/maps?q=${finalLat},${finalLng}`
      : '';
    const text = [
      '<b>🆘 SOS! ЭКСТРЕННЫЙ СИГНАЛ</b>',
      finalSource === 'mesh_relay' ? `<i>(ретрансляция через меш, узел: ${relayed_by ?? '?'})</i>` : '',
      eventId ? '' : '<b>ВНИМАНИЕ: запись в БД не удалась — сигнал НЕ виден Watchdog</b>',
      '',
      tourist_name  ? `👤 Имя: ${tourist_name}`   : '👤 Имя: не указано',
      tourist_phone ? `📞 Тел: ${tourist_phone}`   : '📞 Тел: не указан',
      '',
      `📍 Координаты: ${loc}`,
      mapsLink ? `🗺 <a href="${mapsLink}">Открыть на карте</a>` : '',
      `⚠️ Тип: ${emergency_type ?? 'не указан'}`,
      message       ? `💬 Сообщение: ${message}`   : '',
      `🌐 IP: ${ip}`,
      // Без этой строки тревога про слепую пробу эндпоинта выглядит ровно
      // как тревога про человека в беде, и человек приучается пролистывать
      // обе. Класс — не приговор: сигнал принят и остаётся висеть в любом
      // случае, но получатель имеет право знать, на что смотрит.
      '',
      `🔎 ${origin.words}`,
      origin.signals.length ? `<i>Признаки: ${origin.signals.join(', ')}</i>` : '',
    ].filter(Boolean).join('\n');

    try {
      const tgRes = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      });
      notified = tgRes.ok;
      if (!tgRes.ok) console.error('[safety/sos] Telegram отказал:', tgRes.status);
    } catch (err) {
      console.error('[safety/sos] Telegram недоступен:', err instanceof Error ? err.message : err);
    }
  }

  // Честный ответ: «получен» — только если сигнал реально лёг в базу.
  // Доставка в Telegram — отдельный, вторичный факт (Watchdog видит SOS и
  // без неё), но человек имеет право знать оба.
  if (!eventId) {
    return NextResponse.json({
      success: false,
      notified,
      message: 'Не удалось подтвердить приём SOS-сигнала. Звоните 112 (МЧС) напрямую — не полагайтесь на это уведомление.',
      emergency: {
        mchs: '112',
        ambulance: '103',
      },
    }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    event_id: eventId,
    notified,
    message: 'SOS-сигнал получен. Звоните 112 (МЧС) для немедленной помощи.',
    emergency: {
      mchs: '112',
      ambulance: '103',
    },
  });
}
