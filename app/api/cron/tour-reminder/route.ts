/**
 * GET /api/cron/tour-reminder
 *
 * Запускается ежедневно в 18:00 KMT (06:00 UTC).
 * Находит туры на завтра, отправляет туристу в TG/MAX:
 *   - Напоминание о туре
 *   - Совет по одежде (по погоде Камчатки)
 *   - Предупреждения МЧС / вулканическая активность
 *
 * Для бронирований через бот (metadata.tg_chat_id) и, с 28.08 (issue #1422,
 * «гостевой опыт в брони»), для броней с сайта под аккаунтом с привязанным
 * Telegram — раньше напоминание получали только гости бота. Адрес —
 * TOURIST_TG_CHAT_SQL (lib/notifications/tourist-telegram): до 13.10 здесь
 * читалась только users.telegram_chat_id, которую не пишет никто, а привязка
 * пишет telegram_id, — и туристы с сайта напоминания не получали всё равно.
 * У кого нет ни того, ни другого — честно нет канала, не шлём.
 * После отправки ставит reminder_sent_24h = true.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';
import { maxBot } from '@/lib/max/max-fetch';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { TOURIST_TG_CHAT_SQL } from '@/lib/notifications/tourist-telegram';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';

interface BookingRow {
  id: number;
  tourist_name: string;
  booking_date: string;
  participants: number;
  tour_title: string;
  activity_type: string | null;
  location_name: string | null;
  difficulty: string | null;
  tg_chat_id: number;
  platform: string;
}

async function fetchWeatherForReminder(): Promise<string> {
  try {
    const res = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=53.01&longitude=158.65&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,weathercode&forecast_days=2&timezone=Asia%2FKamchatka',
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return '';
    const data = await res.json() as {
      daily?: {
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_sum?: number[];
        windspeed_10m_max?: number[];
        weathercode?: number[];
      };
    };
    const d = data.daily;
    if (!d) return '';
    // Index 1 = tomorrow
    const maxT = d.temperature_2m_max?.[1];
    const minT = d.temperature_2m_min?.[1];
    const precip = d.precipitation_sum?.[1];
    const wind = d.windspeed_10m_max?.[1];
    const code = d.weathercode?.[1];

    const desc = code !== undefined ? weatherCodeDesc(code) : '';
    return `Петропавловск-Камчатский завтра: ${minT}–${maxT}°C, ${desc}, осадки ${precip ?? 0} мм, ветер до ${wind ?? 0} км/ч.`;
  } catch { return ''; }
}

function weatherCodeDesc(code: number): string {
  if (code === 0) return 'ясно';
  if (code <= 3) return 'переменная облачность';
  if (code <= 48) return 'туман';
  if (code <= 57) return 'морось';
  if (code <= 67) return 'дождь';
  if (code <= 77) return 'снег';
  if (code <= 82) return 'ливень';
  if (code <= 99) return 'гроза';
  return 'переменная погода';
}

async function fetchMchsAlert(): Promise<string> {
  try {
    const res = await fetch('https://www.mchs.gov.ru/rss/list', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return '';
    const xml = await res.text();
    const matches = xml.match(/<title><!\[CDATA\[([^\]]*Камчатк[^\]]*)\]\]>/gi) ?? [];
    if (matches.length === 0) return '';
    const titles = matches.slice(0, 2).map(m => {
      const inner = m.match(/<!\[CDATA\[([^\]]+)\]\]>/);
      return inner?.[1] ?? '';
    }).filter(Boolean);
    return titles.length ? `МЧС: ${titles.join('; ')}` : '';
  } catch { return ''; }
}

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

async function sendMaxMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) return;
  try {
    const bot = maxBot(token);
    await bot.api.sendMessageToChat(chatId, text);
  } catch { /* не блокируем */ }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Отметка прогона в agent_run_history под ключом реестра 'tour-reminder'
  // (аудит 15.10, P4-07): до этого крон был немым, и «перестал запускаться»
  // не видел никто — туристы просто не получали напоминаний.
  const t0 = Date.now();

  // Туры на завтра с chat_id — из бота (metadata) либо из привязанного
  // аккаунта (TOURIST_TG_CHAT_SQL, если брони с сайта; до 13.10 здесь стояла
  // users.telegram_chat_id, которую не пишет никто). Бот в приоритете:
  // если бронь пришла из бота, там тот же чат, что и в metadata.
  let bookings: BookingRow[];
  try {
    ({ rows: bookings } = await pool.query<BookingRow>(`
    SELECT ob.id, ob.tourist_name, ob.booking_date::text, ob.participants,
           ot.title AS tour_title, ot.activity_type, ot.location_name,
           ot.difficulty,
           COALESCE((ob.metadata->>'tg_chat_id')::bigint, ${TOURIST_TG_CHAT_SQL}) AS tg_chat_id,
           COALESCE(ob.metadata->>'platform', 'telegram') AS platform
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
    LEFT JOIN users u ON u.id = ob.user_id
    WHERE ob.booking_date = CURRENT_DATE + INTERVAL '1 day'
      AND ob.booking_status IN ('confirmed', 'pending_payment')
      AND ob.reminder_sent_24h = false
      AND ob.deleted_at IS NULL
      AND (ob.metadata->>'tg_chat_id' IS NOT NULL OR ${TOURIST_TG_CHAT_SQL} IS NOT NULL)
  `));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code ?? 'нет';
    console.error(`[tour-reminder] выборка броней не выполнилась (SQLSTATE ${code}):`, message);
    recordCronRun('tour-reminder', t0, 'failed', { error: `выборка броней: ${code} ${message}`.slice(0, 300) });
    return NextResponse.json({ success: false, error: 'Выборка броней на завтра не выполнилась' }, { status: 500 });
  }

  if (bookings.length === 0) {
    recordCronRun('tour-reminder', t0, 'success', { items: 0 });
    return NextResponse.json({ success: true, sent: 0, message: 'Нет туров на завтра' });
  }

  const [weather, mchs] = await Promise.all([fetchWeatherForReminder(), fetchMchsAlert()]);

  const sent: number[] = [];
  const failed: number[] = [];

  for (const b of bookings) {
    const dateStr = new Date(b.booking_date).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kamchatka',
    });
    const loc = b.location_name ?? 'Камчатка';
    const diff = b.difficulty ?? '';

    const prompt = `Ты Кузьмич — AI-гид по Камчатке. Напиши короткое дружеское напоминание туристу перед туром завтра.

Информация:
- Тур: ${b.tour_title}
- Дата: ${dateStr}
- Место: ${loc}
- Активность: ${b.activity_type ?? 'туризм'}
- Сложность: ${diff || 'средняя'}
- Участников: ${b.participants}
${weather ? `- Прогноз погоды: ${weather}` : ''}
${mchs ? `- Предупреждение МЧС: ${mchs}` : ''}

Структура ответа (3-4 абзаца):
1. Напоминание о туре завтра (кратко, без лести)
2. Что взять с собой / как одеться (конкретно, по погоде)
3. Если есть МЧС-предупреждение — предупредить
4. Короткое пожелание хорошего тура

ВАЖНО: без эмодзи, без markdown, без восклицательных знаков через каждое предложение. Стиль — спокойный, как опытный проводник.`;

    try {
      const message = await callAIFast([
        { role: 'system', content: 'Ты Кузьмич — AI-гид по Камчатке. Без эмодзи. Краткий стиль.' },
        { role: 'user', content: prompt },
      ]);

      if (!message?.trim()) { failed.push(b.id); continue; }

      if (b.platform === 'max') {
        await sendMaxMessage(b.tg_chat_id, message);
      } else {
        await sendTelegramMessage(b.tg_chat_id, message);
      }

      await pool.query(
        `UPDATE operator_bookings SET reminder_sent_24h = true WHERE id = $1`,
        [b.id],
      );
      sent.push(b.id);
    } catch {
      failed.push(b.id);
    }
  }

  // Ни одного напоминания при непустой выборке — отказ, а не успех (§4.0).
  recordCronRun('tour-reminder', t0, sent.length === 0 ? 'failed' : 'success', {
    items: sent.length,
    error: failed.length > 0 ? `не отправлено ${failed.length} из ${bookings.length}` : undefined,
  });

  return NextResponse.json({
    success: true,
    sent: sent.length,
    failed: failed.length,
    booking_ids_sent: sent,
    timestamp: new Date().toISOString(),
  });
}
