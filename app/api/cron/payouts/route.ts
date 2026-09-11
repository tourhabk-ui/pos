/**
 * GET /api/cron/payouts
 *
 * Автоматический релиз HELD платежей по истечении 36 часов после тура.
 * Запускать каждый час через cron-job.org или аналог.
 *
 * Защита: ?secret=<CRON_SECRET> или Authorization: Bearer <CRON_SECRET>
 *
 * ── Разбор денежного пути 11.09 ───────────────────────────────────────────
 *
 * Здесь нашлись три вещи, и все три — из §4.0.
 *
 * 1. ОТКАЗ НЕ ПИСАЛСЯ НИКУДА. `catch (err)` возвращал «Internal error» и
 *    терял `err` целиком: ни имени, ни SQLSTATE. Это деньги оператора,
 *    которые перестали отпускаться, и единственным следом был бы код 500 в
 *    чужой панели cron-job.org. Watchdog ловит последствие (платежи висят
 *    дольше срока), но не причину — причину теперь пишет лог.
 *
 * 2. ЗАМОК БЫЛ НАРИСОВАННЫЙ. `SELECT ... FOR UPDATE SKIP LOCKED` стоял ДО
 *    `BEGIN`, то есть в автокоммите: собственная транзакция оператора
 *    закрывалась сразу, и блокировки снимались в тот же миг. Два
 *    одновременных прогона выбрали бы одни и те же строки — `SKIP LOCKED`
 *    не пропустил бы ничего. Защита читалась как существующая и не была ею.
 *    Теперь выборка внутри той же транзакции, что и запись.
 *
 * 3. ПЕРЕСЧЁТ СТАВКИ УБРАН — см. lib/payments/commission.ts и сторож
 *    `tests/unit/commission-rate-decided.test.ts`. Коротко: функция
 *    `recalculate_commission` не пересчитывает комиссию по этим платежам, а
 *    ПЕРЕЗАПИСЫВАЕТ `partners.commission_current` — ту самую ставку, по
 *    которой считается каждое начисление, — по лестнице за объём. При
 *    ставке 10% (решение владельца 04.08, миграция 811) первый же оператор,
 *    добравшийся до 10 завершённых броней, молча уводил платформу на 7%, а
 *    на 50 — на 5%. Такого решения никто не принимал.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Auth: общий хелпер, сравнение постоянным временем. До 01.09 секрет
  // сравнивался `!==` руками — сторож api-guard-before-action этого больше
  // не пропускает.
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 500 }
    );
  }

  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const client = await pool.connect();
  let inTransaction = false;
  try {
    // Выборка и запись — в ОДНОЙ транзакции: иначе `FOR UPDATE SKIP LOCKED`
    // отпускает блокировки сразу после SELECT и не защищает ни от чего.
    await client.query('BEGIN');
    inTransaction = true;

    // 1. Находим HELD платежи, у которых release_after уже наступил
    const readyRes = await client.query(`
      SELECT id, operator_id, net_amount, booking_id
      FROM tour_payments
      WHERE status = 'HELD'
        AND release_after <= NOW()
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `);

    if (readyRes.rows.length === 0) {
      await client.query('COMMIT');
      inTransaction = false;
      return NextResponse.json({ ok: true, released: 0 });
    }

    const ids = readyRes.rows.map((r: { id: string }) => r.id);

    // 2. Переводим в RELEASED
    await client.query(`
      UPDATE tour_payments
      SET status      = 'RELEASED',
          released_at = NOW()
      WHERE id = ANY($1)
    `, [ids]);

    await client.query('COMMIT');
    inTransaction = false;

    // 3. Уведомляем Telegram о сумме, если есть TELEGRAM_CHAT_ID
    const totalNet = readyRes.rows.reduce(
      (sum: number, r: { net_amount: string }) => sum + parseFloat(r.net_amount),
      0
    );

    const adminChatId = process.env.TELEGRAM_CHAT_ID;
    const botToken    = process.env.TELEGRAM_BOT_TOKEN;
    if (adminChatId && botToken && readyRes.rows.length > 0) {
      const formatted = new Intl.NumberFormat('ru-RU', {
        style: 'currency', currency: 'RUB', minimumFractionDigits: 0,
      }).format(totalNet);
      fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: `Cron payouts: освобождено ${ids.length} платежей на ${formatted}.\nhttps://vedarai.ru/hub/admin/finance`,
          parse_mode: 'HTML',
        }),
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, released: ids.length, totalNet });

  } catch (err) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    // Молчать здесь нельзя: это деньги оператора, которые перестали
    // отпускаться. «Internal error» без причины отправляет искать наугад.
    const e = err as { code?: string; message?: string };
    console.error(
      '[cron/payouts] релиз не выполнен:',
      `sqlstate=${e?.code ?? 'нет'}`,
      e?.message ?? String(err),
    );
    return NextResponse.json(
      { ok: false, error: 'Internal error', sqlstate: e?.code ?? null },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
