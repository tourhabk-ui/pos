import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';

export const dynamic = 'force-dynamic';

interface BookingCountRow { bookings_7d: string }
interface OperatorCountRow { active_operators: string }
interface AlertSentRow { sent_date: string }

async function sendTelegramAlert(message: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_ID;
  if (!token || !chatId) return;

  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  }).catch(() => undefined);
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const [bookingsResult, operatorsResult, alertCheck] = await Promise.all([
    pool.query<BookingCountRow>(
      `SELECT COUNT(*)::text AS bookings_7d
       FROM operator_bookings
       WHERE created_at >= NOW() - INTERVAL '7 days'
         AND (deleted_at IS NULL OR deleted_at > NOW())`,
    ),
    pool.query<OperatorCountRow>(
      `SELECT COUNT(*)::text AS active_operators
       FROM partners
       WHERE category = 'operator'`,
    ),
    pool.query<AlertSentRow>(
      `SELECT value->>'sent_date' AS sent_date
       FROM agent_memory
       WHERE agent_id = 'booking-stall-alert' AND memory_type = 'last_alert' AND key = 'daily'
       LIMIT 1`,
    ),
  ]);

  const bookings7d      = Number(bookingsResult.rows[0]?.bookings_7d ?? 0);
  const activeOperators = Number(operatorsResult.rows[0]?.active_operators ?? 0);
  const lastSentDate    = alertCheck.rows[0]?.sent_date ?? null;

  if (bookings7d > 0) {
    return NextResponse.json({ bookings_7d: bookings7d, active_operators: activeOperators, alert_sent: false });
  }

  if (lastSentDate === today) {
    return NextResponse.json({ bookings_7d: 0, active_operators: activeOperators, alert_sent: false, note: 'already_sent_today' });
  }

  const alertText =
    `<b>Нет бронирований за 7 дней</b>\n\n` +
    `operator_bookings за последние 7 дней: 0\n` +
    `Активных операторов: ${activeOperators}\n\n` +
    `Проверьте форму бронирования и Telegram-бота. Возможен баг или нулевой спрос.`;

  await sendTelegramAlert(alertText);

  await pool.query(
    `INSERT INTO agent_memory (agent_id, memory_type, key, value, confidence, source, memory_tier)
     VALUES ('booking-stall-alert', 'last_alert', 'daily', $1, 1.0, 'cron', 3)
     ON CONFLICT (agent_id, memory_type, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ sent_date: today, bookings_7d: 0, active_operators: activeOperators })],
  );

  return NextResponse.json({ bookings_7d: 0, active_operators: activeOperators, alert_sent: true });
}
