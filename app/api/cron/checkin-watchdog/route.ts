/**
 * GET /api/cron/checkin-watchdog
 * Почасовой сторож маршрутов: эскалирует по лестнице при просрочке возврата.
 * Лестница: soft (спросить туриста) → hard (экстренный контакт) → mchs.
 */
import { NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import {
  decideEscalation,
  resolveControlTime,
  tripKindFromDates,
  buildEscalationMessage,
  formatPositionText,
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
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

async function recordNotification(
  registrationId: string,
  step: EscalationStep,
  channel: string,
  recipient: string,
  status: 'sent' | 'skipped' = 'sent',
): Promise<void> {
  await query(
    `INSERT INTO route_registration_notifications
       (registration_id, step, channel, recipient, status, sent_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [registrationId, stepToNum(step), channel, recipient, status],
  );
}

function stepToNum(step: EscalationStep): number {
  return step === 'soft' ? 1 : step === 'hard' ? 2 : 3;
}

function buildMessage(reg: RegRow, step: EscalationStep, hoursOverdue: number): string {
  return buildEscalationMessage(
    {
      routeName: reg.route_name,
      leaderName: reg.leader_name,
      leaderPhone: reg.leader_phone,
      emergencyContactName: reg.emergency_contact_name,
      emergencyContactPhone: reg.emergency_contact_phone,
      positionText: formatPositionText(reg.last_position_lat, reg.last_position_lng),
      returnUrl: `https://vedarai.ru/return?id=${reg.id}`,
    },
    step,
    hoursOverdue,
  );
}

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !timingSafeCompare(secret ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const startedAt = Date.now();

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
          WHERE n.registration_id = r.id AND n.status IN ('sent', 'skipped')
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

    // Уведомление в зависимости от шага.
    // Важно: recordNotification вызывается ВСЕГДА — иначе шаг не записывается
    // и эскалация стоит на месте при отсутствии Telegram.
    if (step === 'soft') {
      if (reg.emergency_contact_telegram_chat_id) {
        await sendTelegram(reg.emergency_contact_telegram_chat_id, msg);
        await recordNotification(reg.id, step, 'telegram', reg.emergency_contact_phone);
      } else {
        // Нет Telegram — записываем skipped чтобы прогрессировать к hard
        await recordNotification(reg.id, step, 'none', reg.emergency_contact_phone, 'skipped');
      }
    } else if (step === 'hard') {
      if (reg.emergency_contact_telegram_chat_id) {
        await sendTelegram(reg.emergency_contact_telegram_chat_id, msg);
        await recordNotification(reg.id, step, 'telegram', reg.emergency_contact_phone);
      } else {
        await recordNotification(reg.id, step, 'none', reg.emergency_contact_phone, 'skipped');
      }
    } else {
      // mchs — уведомляем admin-чат для ручной передачи в МЧС
      const adminChatId = process.env.TELEGRAM_CHAT_ID;
      if (adminChatId) {
        await sendTelegram(adminChatId, `МЧС-ТРЕВОГА\n\n${msg}`);
        await recordNotification(reg.id, step, 'telegram', 'admin');
      } else {
        await recordNotification(reg.id, step, 'none', 'admin', 'skipped');
      }
    }

    escalated++;
  }

  recordCronRun('checkin-watchdog', startedAt, 'success', { items: processed });
  return NextResponse.json({ success: true, processed, escalated, ts: now.toISOString() });
}
