/**
 * AB Scale Executor — применяет победителя A/B ценового эксперимента.
 *
 * Flow:
 *   1. Ищет запущенные эксперименты >5 дней с metric='booking_count'
 *   2. Считает бронирования на группу A и B
 *   3. Сравнивает booking rates (брони / тур / день)
 *   4. Если B выигрывает >15% и total брони >= 3 → применяет скидку, статус 'completed'
 *   5. Если A или ничья → статус 'completed', цены не меняет
 *   6. Telegram-уведомление с результатами
 *
 * ── Гонка (#1428, судья 28.08; закрыто 02.09) ────────────────────────────
 *
 * До 02.09 шаги 2-5 шли отдельными pool.query без транзакции. Два
 * пересёкшихся прогона крона (расписания GitHub доезжают пачками) читали
 * один и тот же running-эксперимент, и ОБА применяли скидку: цена группы B
 * уменьшалась дважды, а price_old второго прогона запоминал уже сниженную
 * цену — откатить к настоящей становилось нечем. Статус completed ставили
 * оба, и в истории это выглядело как один аккуратный прогон.
 *
 * Теперь на каждый эксперимент — ОДНА транзакция, и первым её действием
 * строка эксперимента берётся `FOR UPDATE SKIP LOCKED` с повторной проверкой
 * `status = 'running'`. Второй прогон либо не получает строку (её держит
 * первый) и пропускает эксперимент вслух, либо получает уже completed и тоже
 * пропускает. Скидка и статус пишутся тем же соединением до COMMIT — либо
 * оба, либо ни одного.
 *
 * Сторож: tests/unit/ab-scale-transaction.test.ts — исполняет функцию на
 * записывающем клиенте и проверяет порядок BEGIN → FOR UPDATE → записи →
 * COMMIT, пропуск при занятой строке и ROLLBACK при отказе записи.
 */

import { pool } from '@/lib/db-pool';

// Локальные типы — избегаем циклического импорта из initiative-executor
export interface ExecutionTask {
  approval_id: string;
  executor_agent_id: string;
  action_type: string;
  description: string;
  context: Record<string, unknown>;
  due_date: string;
}

export interface ExecutionResult {
  success: boolean;
  changes_made: string[];
  errors: string[];
  rollback_available: boolean;
  verification_passed: boolean;
}

interface ExperimentRow {
  id: string;
  name: string;
  created_at: Date;
  variant_a: { label: string; tour_ids: number[] };
  variant_b: { label: string; tour_ids: number[]; discount_pct?: number };
}

interface BookingCountRow {
  variant: string;
  bookings: number;
}

/** Минимум, который нужен от соединения: запрос и возврат в пул. */
interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
interface PoolClient extends Queryable {
  release(): void;
}

type Winner = 'a' | 'b' | 'tie';

/**
 * Один эксперимент — одна транзакция под блокировкой строки. Возвращает
 * строки для отчёта; бросает, если запись не удалась (после ROLLBACK).
 */
async function settleExperiment(expId: string): Promise<string[]> {
  const changes: string[] = [];
  const client = (await pool.connect()) as unknown as PoolClient;
  try {
    await client.query('BEGIN');

    // Замок: строка берётся под запись, занятая другим прогоном —
    // пропускается, а не ждётся. Повторная проверка статуса закрывает
    // второй случай гонки: первый прогон уже закоммитил completed.
    const locked = await client.query<ExperimentRow>(
      `SELECT id, name, created_at, variant_a, variant_b
         FROM agent_experiments
        WHERE id = $1 AND status = 'running'
        FOR UPDATE SKIP LOCKED`,
      [expId],
    );
    const exp = locked.rows[0];
    if (!exp) {
      await client.query('COMMIT');
      changes.push(`Эксперимент ${expId.slice(0, 8)}: занят другим прогоном или уже завершён — пропущен`);
      return changes;
    }

    const ageInDays = (Date.now() - new Date(exp.created_at).getTime()) / (1000 * 60 * 60 * 24);

    // ── Step 2: Count bookings per group ────────────────────────────────────
    const counts = await client.query<BookingCountRow>(
      `SELECT
         'a' as variant,
         COUNT(ob.id)::int as bookings
       FROM agent_experiments e
       CROSS JOIN LATERAL (
         SELECT jsonb_array_elements_text(e.variant_a->'tour_ids')::int AS tour_id
       ) ta
       JOIN operator_bookings ob ON ob.operator_tour_id = ta.tour_id
         AND ob.created_at > e.created_at
         AND ob.deleted_at IS NULL
       WHERE e.id = $1

       UNION ALL

       SELECT
         'b' as variant,
         COUNT(ob.id)::int as bookings
       FROM agent_experiments e
       CROSS JOIN LATERAL (
         SELECT jsonb_array_elements_text(e.variant_b->'tour_ids')::int AS tour_id
       ) tb
       JOIN operator_bookings ob ON ob.operator_tour_id = tb.tour_id
         AND ob.created_at > e.created_at
         AND ob.deleted_at IS NULL
       WHERE e.id = $1`,
      [exp.id],
    );

    const aRow = counts.rows.find(r => r.variant === 'a');
    const bRow = counts.rows.find(r => r.variant === 'b');

    const aBookings = aRow?.bookings ?? 0;
    const bBookings = bRow?.bookings ?? 0;
    const totalBookings = aBookings + bBookings;

    const aTourCount = Array.isArray(exp.variant_a?.tour_ids) ? exp.variant_a.tour_ids.length : 1;
    const bTourCount = Array.isArray(exp.variant_b?.tour_ids) ? exp.variant_b.tour_ids.length : 1;

    // Rate = bookings per tour per day
    const aRate = aTourCount > 0 ? (aBookings / aTourCount / ageInDays) : 0;
    const bRate = bTourCount > 0 ? (bBookings / bTourCount / ageInDays) : 0;

    // ── Step 3: Determine winner ──────────────────────────────────────────
    const bWinsBy = aRate > 0 ? ((bRate - aRate) / aRate) * 100 : (bRate > 0 ? 100 : 0);

    let winner: Winner;
    if (bWinsBy > 15 && totalBookings >= 3) {
      winner = 'b';
    } else if (aRate > bRate) {
      winner = 'a';
    } else if (bRate > aRate) {
      winner = 'b'; // wins but not by threshold
    } else {
      winner = 'tie';
    }

    changes.push(
      `Эксперимент "${exp.name}": A=${aBookings} броней (${aRate.toFixed(3)}/тур/день), ` +
      `B=${bBookings} броней (${bRate.toFixed(3)}/тур/день), всего=${totalBookings}, победитель=${winner}`,
    );

    // ── Step 4: Apply discount if B wins convincingly ───────────────────
    if (winner === 'b' && bWinsBy > 15 && totalBookings >= 3) {
      const discountPct = typeof exp.variant_b?.discount_pct === 'number'
        ? exp.variant_b.discount_pct
        : 10;

      const bTourIds = exp.variant_b?.tour_ids ?? [];

      if (bTourIds.length > 0) {
        await client.query(
          `UPDATE operator_tours
           SET base_price = ROUND(base_price * (1 - $1::numeric / 100), 0),
               price_old = base_price,
               updated_at = NOW()
           WHERE id = ANY($2::int[])
             AND deleted_at IS NULL`,
          [discountPct, bTourIds],
        );
        changes.push(
          `Применена скидка ${discountPct}% к ${bTourIds.length} турам группы B ` +
          `(B выиграл на ${bWinsBy.toFixed(1)}%)`,
        );
      }
    }

    // ── Step 5: Mark experiment completed — тем же соединением, до COMMIT ──
    await client.query(
      `UPDATE agent_experiments
       SET status = 'completed',
           winner = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [exp.id, winner],
    );

    await client.query('COMMIT');
    changes.push(`Эксперимент ${exp.id.slice(0, 8)} → статус completed, winner=${winner}`);
    return changes;
  } catch (err) {
    // Откат обоих UPDATE разом: скидка без completed оставила бы эксперимент
    // running, и следующий прогон применил бы её снова.
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function executeABScaleWinner(task: ExecutionTask): Promise<ExecutionResult> {
  const changes: string[] = [];
  const errors:  string[] = [];

  try {
    // ── Step 1: Find running experiments > 5 days with metric='booking_count' ──
    // Список — только кандидаты. Решение по каждому принимается под
    // блокировкой в settleExperiment, потому что между этим SELECT и записью
    // другой прогон мог завершить эксперимент.
    const experiments = await pool.query<{ id: string }>(
      `SELECT id
       FROM agent_experiments
       WHERE metric = 'booking_count'
         AND status = 'running'
         AND created_at < NOW() - INTERVAL '5 days'
       ORDER BY created_at ASC
       LIMIT 10`
    );

    if (experiments.rows.length === 0) {
      return {
        success: true,
        changes_made: ['Нет A/B экспериментов готовых к оценке (>5 дней, running, booking_count)'],
        errors: [],
        rollback_available: false,
        verification_passed: true,
      };
    }

    changes.push(`Найдено ${experiments.rows.length} экспериментов для оценки`);

    for (const exp of experiments.rows) {
      try {
        changes.push(...await settleExperiment(exp.id));
      } catch (expErr) {
        errors.push(
          `Эксперимент ${exp.id.slice(0, 8)}: ` +
          (expErr instanceof Error ? expErr.message : String(expErr))
        );
      }
    }

    // ── Step 6: Telegram notification ──────────────────────────────────────────
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId   = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    chatId,
          parse_mode: 'HTML',
          text: [
            '<b>A/B Scale Winner — результаты</b>',
            '',
            `Обработано экспериментов: ${experiments.rows.length}`,
            `Изменений: ${changes.length}`,
            errors.length > 0 ? `Ошибок: ${errors.length}` : 'Ошибок нет',
          ].join('\n'),
        }),
      }).catch(() => null);
    }

    return {
      success:             errors.length === 0,
      changes_made:        changes,
      errors,
      rollback_available:  true,
      verification_passed: true,
    };

  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return {
      success:             false,
      changes_made:        changes,
      errors,
      rollback_available:  false,
      verification_passed: false,
    };
  }
}
