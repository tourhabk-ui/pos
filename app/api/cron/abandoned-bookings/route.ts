/**
 * GET /api/cron/abandoned-bookings?secret=<CRON_SECRET>[&dry=1]
 *
 * Восстановление незавершённых бронирований (статус pending_payment):
 * — 2+ часа без оплаты → Telegram-напоминание оператору
 * — 24+ часа без оплаты → авто-отмена (booking_status = 'cancelled')
 *
 * Запускать каждый час (GitHub Actions или Timeweb).
 *
 * ВОЗРАСТ БРОНИ СЧИТАЕТСЯ ОТ created_at, А НЕ ОТ updated_at.
 * На operator_bookings висит триггер trigger_operator_bookings_timestamp
 * (миграция 040), который двигает updated_at при ЛЮБОМ UPDATE — в том числе
 * при нашей же отметке об отправленном напоминании. То есть по updated_at
 * напоминание отодвигало собственный срок отмены на два часа, а любое касание
 * брони оператором продлевало её бесконечно. Часы, которые переставляет тот,
 * кого они считают, — не часы.
 *
 * `?dry=1` — сухой прогон: те же выборки, ни одной записи. Нужен, чтобы
 * увидеть размер партии отмены ДО того, как она случится.
 *
 * ОТМЕНА НЕ ТРОГАЕТ БРОНЬ, НА КОТОРОЙ ЛЕЖАТ ДЕНЬГИ. Настоящее столкновение с
 * оплатой идёт не здесь, а через приёмник Точки: тот читает бронь, УХОДИТ
 * СПРАШИВАТЬ БАНК и только потом пишет подтверждение. В этом окне отмена
 * успевает отменить, приёмник записывает ноль строк, а деньги у банка приняты.
 * Чинится оно на своей стороне (см. вебхук), но и здесь условие отмены обязано
 * отказываться от строки, несущей оплату: `paid_at` или `payment_status =
 * 'paid'` означают деньги, и отменять такую бронь автомату нельзя ни при каком
 * порядке событий. Любая будущая правка приёмника, разводящая отметку оплаты и
 * смену статуса по разным запросам, без этого условия становится потерей денег
 * туриста.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** true — сообщение ушло, false — не смогли отправить. Молча не глотаем. */
async function notifyTelegram(telegramId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(
      `${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) {
      console.error('[abandoned-bookings] telegram отказал', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[abandoned-bookings] telegram недоступен',
      err instanceof Error ? err.message : err);
    return false;
  }
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1';
  const startedAt = Date.now();
  const now = new Date();

  // Счётчики раздельные намеренно. Прежде всё сводилось к одному `reminded`,
  // который рос и когда telegram_id не было вовсе, и когда отправка падала, —
  // то есть считал не напоминания, а итерации цикла.
  let reminded = 0;          // сообщение ушло оператору
  let noTelegram = 0;        // оператору некуда писать: у пользователя нет telegram_id
  let sendFailed = 0;        // отправка не удалась
  let markFailed = 0;        // отправили, но не смогли записать отметку → уйдёт снова

  try {
    // ── 1. Найти брони 2–24 ч без оплаты → уведомить оператора ──────
    const { rows: remindRows } = await pool.query<{
      id: number;
      tourist_name: string;
      final_price: number;
      created_at: Date;
      telegram_id: string | null;
    }>(`
      SELECT ob.id, ob.tourist_name, ob.final_price, ob.created_at,
             u.telegram_id
      FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      JOIN partners p         ON p.id  = ot.operator_id
      JOIN users u            ON u.id  = p.user_id
      WHERE ob.booking_status = 'pending_payment'
        AND ob.created_at < NOW() - INTERVAL '2 hours'
        AND ob.created_at > NOW() - INTERVAL '24 hours'
        AND (ob.metadata->>'reminder_sent_2h') IS NULL
    `);

    for (const row of remindRows) {
      if (!row.telegram_id) {
        noTelegram++;
        continue;
      }

      const hoursAgo = Math.round(
        (now.getTime() - new Date(row.created_at).getTime()) / 3_600_000,
      );
      const text = [
        '<b>Незавершённая оплата</b>',
        '',
        `Бронирование #${row.id} ждёт оплаты уже ${hoursAgo} ч.`,
        `Турист: ${escHtml(row.tourist_name)}`,
        `Сумма: ${Number(row.final_price).toLocaleString('ru-RU')} ₽`,
        '',
        `Автоматически отменится через ${Math.max(0, 24 - hoursAgo)} ч.`,
        `<a href="https://vedarai.ru/hub/operator/bookings">Открыть бронирования</a>`,
      ].join('\n');

      if (dryRun) { reminded++; continue; }

      if (!(await notifyTelegram(row.telegram_id, text))) {
        sendFailed++;
        continue; // отметку не ставим: пусть попробует ещё раз через час
      }

      // Отметка о напоминании. Её отказ нельзя глотать: без неё то же самое
      // напоминание уйдёт оператору снова на следующем часе, и так до отмены.
      try {
        await pool.query(
          `UPDATE operator_bookings
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
           WHERE id = $2`,
          [JSON.stringify({ reminder_sent_2h: new Date().toISOString() }), row.id],
        );
      } catch (err) {
        markFailed++;
        console.error('[abandoned-bookings] отметка reminder_sent_2h не записана',
          row.id, err instanceof Error ? err.message : err);
      }

      reminded++;
    }

    // ── 2. Авто-отмена бронирований 24+ ч без оплаты ─────────────────
    // Гонки с оплатой здесь нет: приёмники платежей меняют статус только
    // условием booking_status = 'pending_payment', а PostgreSQL в READ
    // COMMITTED перепроверяет WHERE на новой версии строки после взятия
    // блокировки. Кто закоммитил первым — тот и выиграл, второй строку
    // пропустит. Отдельный SELECT ... FOR UPDATE ничего к этому не добавит.
    const cancelSql = `
      SELECT id FROM operator_bookings
      WHERE booking_status = 'pending_payment'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND paid_at IS NULL
        AND (payment_status IS NULL OR payment_status <> 'paid')`;

    let cancelled: number;
    if (dryRun) {
      const { rows } = await pool.query<{ id: number }>(cancelSql);
      cancelled = rows.length;
    } else {
      const { rows } = await pool.query<{ id: number }>(
        `UPDATE operator_bookings
         SET booking_status       = 'cancelled',
             cancellation_reason  = 'Оплата не поступила в течение 24 часов',
             cancelled_at         = NOW(),
             updated_at           = NOW()
         WHERE booking_status = 'pending_payment'
           AND created_at < NOW() - INTERVAL '24 hours'
           AND paid_at IS NULL
           AND (payment_status IS NULL OR payment_status <> 'paid')
         RETURNING id`,
      );
      cancelled = rows.length;
    }

    recordCronRun('payments', startedAt, 'success', { items: reminded + cancelled });

    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      reminded,
      no_telegram: noTelegram,
      send_failed: sendFailed,
      mark_failed: markFailed,
      cancelled,
      ts: now.toISOString(),
    });

  } catch (err) {
    // Отказ прогона обязан быть виден Watchdog'у. Прежде heartbeat писался
    // 'success' ДО работы, и упавший крон выглядел живым и здоровым.
    const msg = err instanceof Error ? err.message : 'Ошибка';
    console.error('[abandoned-bookings] прогон не удался:', msg);
    recordCronRun('payments', startedAt, 'failed', { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
