/**
 * GET /api/cron/commission-dry-run — что записалось бы в комиссию по броне.
 * ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод. Таблицы `operator_commissions` на проде не существовало, вставка
 * падала на «relation does not exist», а пустой `catch` превращал это в
 * «ничего не произошло»: отсутствие комиссий выглядело как отсутствие продаж.
 * Таблица восстановлена миграцией 907, тип `booking_id` подтверждён замером.
 * Но «таблица есть» и «комиссия начисляется» — РАЗНЫЕ утверждения, и второе
 * до сих пор ничем не доказано: с момента починки не было ни одной оплаты.
 *
 * Начисление — это один `INSERT ... SELECT` с двумя JOIN и ставкой из
 * `partners.commission_current`. Если этот SELECT вернёт пусто — не сойдётся
 * джойн, не окажется партнёра, `final_price` будет ноль, — комиссия молча не
 * запишется. Узнать об этом ПОСЛЕ оплаты значит разбираться, куда делись
 * деньги; узнать ДО — стоит одного запроса.
 *
 * Здесь тот же SELECT прогоняется вхолостую и разбирается по звеньям: какое
 * из них порвалось, названо поимённо. Ноль строк без объяснения — тот самый
 * второй исход вместо третьего, которого правило §4.0 не допускает.
 *
 * Наружу уходят идентификаторы, суммы и ставка. Имя, почта и телефон туриста
 * НЕ отдаются: ответ читают в логах Actions, а это персональные данные.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { PLATFORM_COMMISSION_PERCENT } from '@/lib/payments/commission';

export const dynamic = 'force-dynamic';

interface LinkRow {
  booking_id: string;
  final_price: string | null;
  paid_at: string | null;
  operator_tour_id: string | null;
  tour_title: string | null;
  operator_id: string | null;
  partner_name: string | null;
  commission_current: string | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bookingParam = new URL(request.url).searchParams.get('booking');

  try {
    // Цепочка разбирается ЛЕВЫМИ соединениями намеренно: внутренние просто
    // не вернули бы строку, и порвавшееся звено осталось бы неназванным.
    const { rows } = await pool.query<LinkRow>(
      `SELECT ob.id::text        AS booking_id,
              ob.final_price::text,
              ob.paid_at::text,
              ob.operator_tour_id::text,
              ot.title           AS tour_title,
              ot.operator_id::text,
              COALESCE(p.company_name, p.name) AS partner_name,
              p.commission_current::text
         FROM operator_bookings ob
         LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
         LEFT JOIN partners p        ON p.id = ot.operator_id
        WHERE ($1::text IS NULL OR ob.id::text = $1)
          AND ob.deleted_at IS NULL
        ORDER BY ob.created_at DESC NULLS LAST
        LIMIT 20`,
      [bookingParam],
    );

    if (rows.length === 0) {
      return NextResponse.json({
        ok: true,
        checked: 0,
        note: bookingParam
          ? `брони ${bookingParam} нет или она удалена — начислять не по чему`
          : 'живых броней нет вовсе: начисление проверять не на чем, это не «комиссия работает»',
      });
    }

    const verdicts = rows.map((r) => {
      const price = r.final_price === null ? null : Number(r.final_price);
      const rate = r.commission_current === null ? null : Number(r.commission_current);

      // Каждое звено называется отдельно. «Не записалось бы» без причины —
      // то же молчание, что и пустой catch.
      const blockers: string[] = [];
      if (!r.operator_tour_id) blockers.push('у брони нет operator_tour_id');
      else if (!r.tour_title) blockers.push('тур по operator_tour_id не найден');
      if (r.operator_tour_id && r.tour_title && !r.operator_id) blockers.push('у тура нет operator_id');
      if (r.operator_id && !r.partner_name) blockers.push('партнёр по operator_id не найден');
      if (price === null) blockers.push('final_price пуст');
      else if (!(price > 0)) blockers.push(`final_price = ${price}, а вставка требует > 0`);

      // Ставка: источник истины — partners.commission_current; константа
      // только запасная, и если сработала она, это надо видеть.
      const effectiveRate = rate ?? PLATFORM_COMMISSION_PERCENT;
      const rateSource = rate === null ? `запасная константа ${PLATFORM_COMMISSION_PERCENT}%` : 'partners.commission_current';

      return {
        booking_id: r.booking_id,
        paid: r.paid_at !== null,
        paid_at: r.paid_at,
        tour: r.tour_title,
        partner: r.partner_name,
        final_price: price,
        rate_percent: effectiveRate,
        rate_source: rateSource,
        would_insert: blockers.length === 0,
        // Ровно та же арифметика, что в INSERT: процент делится на 100.
        would_amount: blockers.length === 0 && price !== null
          ? Math.round(price * effectiveRate) / 100
          : null,
        blockers,
      };
    });

    // След в данных: оплаченные брони без строки комиссии. Именно он, а не
    // наличие таблицы, отвечает на вопрос «начисляется ли».
    const { rows: trace } = await pool.query<{ paid_total: number; commissions_total: number; paid_without_commission: number }>(
      `SELECT (SELECT COUNT(*)::int FROM operator_bookings
                WHERE paid_at IS NOT NULL AND deleted_at IS NULL)          AS paid_total,
              (SELECT COUNT(*)::int FROM operator_commissions)             AS commissions_total,
              (SELECT COUNT(*)::int FROM operator_bookings ob
                WHERE ob.paid_at IS NOT NULL AND ob.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM operator_commissions oc
                                   WHERE oc.booking_id = ob.id))           AS paid_without_commission`,
    );

    return NextResponse.json({
      ok: true,
      collected_at: new Date().toISOString(),
      checked: verdicts.length,
      bookings: verdicts,
      trace: trace[0] ?? null,
    });
  } catch (err) {
    // Третий исход: не смог проверить — это не «начислять нечего».
    const e = err as { code?: string; message?: string };
    console.error(
      '[commission-dry-run] проверка не выполнена:',
      `sqlstate=${e?.code ?? 'нет'}`,
      e?.message ?? String(err),
    );
    return NextResponse.json(
      { ok: false, reason: e?.message ?? 'база не ответила', sqlstate: e?.code ?? null },
      { status: 500 },
    );
  }
}
