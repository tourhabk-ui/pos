/**
 * lib/agents/checkin-monitor.ts
 *
 * Мониторинг туристических чекинов.
 * Запускается каждые 30 минут через /api/cron/checkin-monitor.
 *
 * Логика: ищет активные чекины с просроченным дедлайном → отправляет
 * алерт в TELEGRAM_CHAT_ID с контактными данными для связи с близкими.
 */

import { pool } from '@/lib/db-pool';

interface OverdueCheckin {
  id: string;
  tourist_name: string;
  route_name: string;
  return_deadline: Date;
  emergency_name: string;
  emergency_phone: string | null;
  emergency_telegram: string | null;
  last_lat: string | null;
  last_lng: string | null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function tgSend(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

export async function runCheckinMonitor(): Promise<{ alerted: number; checked: number }> {
  const { rows } = await pool.query<OverdueCheckin>(`
    SELECT id, tourist_name, route_name, return_deadline,
           emergency_name, emergency_phone, emergency_telegram,
           last_lat::text, last_lng::text
    FROM tourist_checkins
    WHERE status = 'active'
      AND return_deadline < NOW()
      AND alert_count = 0
  `);

  let alerted = 0;

  for (const c of rows) {
    const overdue = Math.round((Date.now() - new Date(c.return_deadline).getTime()) / 60000);
    const geo = c.last_lat && c.last_lng
      ? `\n<b>Последняя позиция:</b> ${esc(c.last_lat)}, ${esc(c.last_lng)} (указана при регистрации)`
      : '';

    const contact = [
      c.emergency_phone ? `тел: ${esc(c.emergency_phone)}` : null,
      c.emergency_telegram ? `Telegram: ${esc(c.emergency_telegram)}` : null,
    ].filter(Boolean).join(', ');

    const msg = [
      '⚠️ <b>Турист не вернулся вовремя</b>',
      '',
      `<b>Турист:</b> ${esc(c.tourist_name)}`,
      `<b>Маршрут:</b> ${esc(c.route_name)}`,
      `<b>Ожидался к:</b> ${new Date(c.return_deadline).toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka' })} (КСВ)`,
      `<b>Опоздание:</b> ${overdue} мин`,
      `<b>Экстренный контакт:</b> ${esc(c.emergency_name)} — ${contact || 'не указан'}`,
      geo,
    ].filter(s => s !== undefined).join('\n');

    const sent = await tgSend(msg);

    if (sent) {
      await pool.query(
        `UPDATE tourist_checkins
         SET status = 'alerted', alert_sent_at = NOW(), alert_count = 1
         WHERE id = $1`,
        [c.id]
      );
      alerted++;
    }
    // If tgSend failed: alert_count stays 0, next cron tick will retry
  }

  return { alerted, checked: rows.length };
}
