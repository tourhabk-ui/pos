/**
 * GET /api/cron/checkin-watchdog
 * Почасовой сторож маршрутов: эскалирует по лестнице при просрочке возврата.
 * Лестница: soft (спросить туриста) → hard (экстренный контакт) → mchs.
 */
import { NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import {
  decideEscalation,
  resolveControlTime,
  tripKindFromDates,
} from '@/lib/safety/checkin-escalation';
import type { EscalationStep } from '@/lib/safety/checkin-escalation';

export const dynamic = 'force-dynamic';

interface RegRow {
  id: string;
  route_name: string;
  start_date: Date;
  end_date: Date;
  expected_return_at: Date | null;
  trip_kind: 'day' | 'multi';
  checkin_confirmed_at: Date | null;
  last_position_lat: string | null;
  last_position_lng: string | null;
  leader_name: string;
  leader_phone: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_telegram_chat_id: string | null;
  sent_steps: string[];
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

async function recordNotification(registrationId: string, step: EscalationStep, channel: string, recipient: string): Promise<void> {
  await query(
    `INSERT INTO route_registration_notifications
       (registration_id, step, channel, recipient, status, sent_at)
     VALUES ($1, $2, $3, $4, 'sent', now())
     ON CONFLICT DO NOTHING`,
    [registrationId, stepToNum(step), channel, recipient],
  );
}

function stepToNum(step: EscalationStep): number {
  return step === 'soft' ? 1 : step === 'hard' ? 2 : 3;
}

function formatPosition(lat: string | null, lng: string | null): string {
  if (!lat || !lng) return 'неизвестно';
  return `${parseFloat(lat).toFixed(5)}° N, ${parseFloat(lng).toFixed(5)}° E`;
}

function buildMessage(reg: RegRow, step: EscalationStep, hoursOverdue: number): string {
  const pos = formatPosition(reg.last_position_lat, reg.last_position_lng);
  const hours = hoursOverdue.toFixed(1);

  if (step === 'soft') {
    return (
      `Вы зарегистрировали маршрут "${reg.route_name}" и ещё не отметились о возвращении.\n` +
      `Просрочка: ${hours} ч. Если вы уже вернулись — нажмите «Я вернулся» в приложении.\n` +
      `Если нужна помощь — звоните 112.`
    );
  }
  if (step === 'hard') {
    return (
      `ВНИМАНИЕ: турист ${reg.leader_name} (${reg.leader_phone}) не вернулся с маршрута ` +
      `"${reg.route_name}" уже ${hours} ч.\n` +
      `Последняя известная позиция: ${pos}.\n` +
      `Пожалуйста, свяжитесь с туристом. Если контакт не удался — звоните 112.`
    );
  }
  return (
    `ЭКСТРЕННАЯ СИТУАЦИЯ: турист ${reg.leader_name} (${reg.leader_phone}) не вернулся с маршрута ` +
    `"${reg.route_name}" уже ${hours} ч.\n` +
    `Экстренный контакт: ${reg.emergency_contact_name} (${reg.emergency_contact_phone}).\n` +
    `Последняя известная позиция: ${pos}.\n` +
    `Рекомендуем немедленно сообщить в МЧС: 112.`
  );
}

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !timingSafeCompare(secret ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();

  // Регистрации без отметки о возвращении с ожидаемым временем в прошлом (или дата уже прошла)
  const { rows } = await query<RegRow>(`
    SELECT
      r.id,
      r.route_name,
      r.start_date,
      r.end_date,
      r.expected_return_at,
      COALESCE(r.trip_kind, 'day') AS trip_kind,
      r.checkin_confirmed_at,
      r.last_position_lat::text,
      r.last_position_lng::text,
      r.leader_name,
      r.leader_phone,
      r.emergency_contact_name,
      r.emergency_contact_phone,
      r.emergency_contact_telegram_chat_id::text,
      COALESCE(
        ARRAY(
          SELECT CASE n.step
            WHEN 1 THEN 'soft' WHEN 2 THEN 'hard' ELSE 'mchs'
          END
          FROM route_registration_notifications n
          WHERE n.registration_id = r.id AND n.status = 'sent'
          ORDER BY n.step
        ),
        ARRAY[]::text[]
      ) AS sent_steps
    FROM route_registrations r
    WHERE r.completed_at IS NULL
      AND (
        r.expected_return_at IS NOT NULL AND r.expected_return_at < $1
        OR
        r.expected_return_at IS NULL AND r.end_date < $2
      )
    ORDER BY COALESCE(r.expected_return_at, r.end_date::timestamptz) ASC
    LIMIT 100
  `, [now, now]);

  let processed = 0;
  let escalated = 0;

  for (const reg of rows) {
    processed++;

    const tripKind = reg.trip_kind ?? tripKindFromDates(new Date(reg.start_date), new Date(reg.end_date));
    const controlTime = resolveControlTime(new Date(reg.end_date), reg.expected_return_at ? new Date(reg.expected_return_at) : null);
    const alreadySent = (reg.sent_steps ?? []) as EscalationStep[];
    const confirmedAt = reg.checkin_confirmed_at ? new Date(reg.checkin_confirmed_at) : null;

    const decision = decideEscalation(controlTime, tripKind, alreadySent, confirmedAt, now);
    if (!decision) continue;

    const { step, hoursOverdue } = decision;
    const msg = buildMessage(reg, step, hoursOverdue);

    // Уведомление в зависимости от шага
    if (step === 'soft') {
      // Спрашиваем самого туриста (если есть Telegram экстренного контакта как прокси)
      if (reg.emergency_contact_telegram_chat_id) {
        await sendTelegram(reg.emergency_contact_telegram_chat_id, msg);
        await recordNotification(reg.id, step, 'telegram', reg.emergency_contact_phone);
      }
    } else if (step === 'hard') {
      if (reg.emergency_contact_telegram_chat_id) {
        await sendTelegram(reg.emergency_contact_telegram_chat_id, msg);
        await recordNotification(reg.id, step, 'telegram', reg.emergency_contact_phone);
      }
    } else {
      // mchs — уведомляем admin-чат для ручной передачи в МЧС
      const adminChatId = process.env.TELEGRAM_CHAT_ID;
      if (adminChatId) {
        await sendTelegram(adminChatId, `МЧС-ТРЕВОГА\n\n${msg}`);
        await recordNotification(reg.id, step, 'telegram', 'admin');
      }
    }

    escalated++;
  }

  return NextResponse.json({ success: true, processed, escalated, ts: now.toISOString() });
}
