/**
 * GET  /api/safety/reports — последние подтверждённые наблюдения туристов
 * POST /api/safety/reports — сообщить о наблюдении с маршрута (анонимно, rate-limit)
 *
 * Trust-first: юзер-репорты — это НЕ официальные данные. Создаются в status
 * 'pending', наружу отдаются только 'approved', и клиент обязан помечать их
 * «наблюдение туриста, не проверено». Модерация — вручную владельцем
 * (Telegram-нотификация о каждом новом репорте).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { containsProfanity } from '@/lib/services/profanity-filter';
import { withinKamchatka } from '@/lib/services/routes/geocode';

export const dynamic = 'force-dynamic';

const reportLimiter = createRateLimiter({ windowMs: 60_000 * 60, max: 5 }); // 5 в час с IP

const REPORT_TYPE_LABELS: Record<string, string> = {
  bear: 'Медведь',
  rockfall: 'Камнепад',
  weather: 'Опасная погода',
  other: 'Другое',
};

const PostSchema = z.object({
  report_type: z.enum(['bear', 'rockfall', 'weather', 'other']),
  text: z.string().trim().min(3, 'Опишите наблюдение (минимум 3 символа)').max(500),
  // Границы проверяются отдельно (withinKamchatka) — общий с гео-гейтом
  // маршрутов (migration 709) источник правды, не дублируем bbox здесь.
  // z.number() уже отклоняет NaN, так что null-island (0,0) не пройдёт дальше.
  lat: z.number().finite().optional(),
  lng: z.number().finite().optional(),
});

function notifyOwnerAsync(type: string, text: string, lat?: number, lng?: number): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const coords = lat != null && lng != null ? `\nКоординаты: ${lat.toFixed(5)}, ${lng.toFixed(5)}` : '';
  const msg =
    `<b>Наблюдение с маршрута</b> (ждёт модерации)\n` +
    `Тип: ${REPORT_TYPE_LABELS[type] ?? type}\n` +
    `${text}${coords}\n\n` +
    `Одобрить: UPDATE trail_reports SET status='approved' WHERE status='pending' ORDER BY created_at DESC — /hub/admin`;
  // fire-and-forget — нотификация не должна блокировать ответ туристу
  void fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
}

export async function GET() {
  try {
    const result = await query<{
      id: string;
      report_type: string;
      text: string;
      lat: number | null;
      lng: number | null;
      created_at: string;
    }>(
      `SELECT id, report_type, text, lat, lng, created_at
       FROM trail_reports
       WHERE status = 'approved'
       ORDER BY created_at DESC
       LIMIT 10`
    );
    return NextResponse.json({
      success: true,
      data: result.rows.map(r => ({
        ...r,
        type_label: REPORT_TYPE_LABELS[r.report_type] ?? r.report_type,
      })),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка загрузки наблюдений' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!reportLimiter.check(ip)) {
    return NextResponse.json(
      { success: false, error: 'Слишком много сообщений. Попробуйте через час.' },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Неверные данные', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { report_type, text, lat, lng } = parsed.data;

  // Координаты вне Камчатки (или явный null-island 0,0) — не пишем в БД.
  // Тот же гео-гейт, что у маршрутов (migration 709): ложная метка опасности
  // на карте безопасности хуже, чем наблюдение без координат.
  if (lat !== undefined && lng !== undefined && !withinKamchatka(lat, lng)) {
    return NextResponse.json(
      { success: false, error: 'Координаты вне Камчатки — наблюдение не сохранено', code: 'OUT_OF_BOUNDS' },
      { status: 422 }
    );
  }

  // Мат — на входе (репорты видны публично после модерации; fail-open:
  // недоступность PurgoMalum не блокирует легитимное сообщение о медведе)
  const profane = await containsProfanity(text);
  if (profane === true) {
    return NextResponse.json(
      { success: false, error: 'Сообщение содержит недопустимую лексику. Пожалуйста, перефразируйте.' },
      { status: 422 }
    );
  }

  try {
    const result = await query<{ id: string }>(
      `INSERT INTO trail_reports (report_type, text, lat, lng)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [report_type, text, lat ?? null, lng ?? null]
    );

    notifyOwnerAsync(report_type, text, lat, lng);

    return NextResponse.json(
      {
        success: true,
        data: { id: result.rows[0].id, status: 'pending' },
        message: 'Спасибо! Наблюдение отправлено на проверку и появится в радаре после модерации.',
      },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ success: false, error: 'Не удалось сохранить наблюдение' }, { status: 500 });
  }
}
