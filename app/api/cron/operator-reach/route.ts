/**
 * GET /api/cron/operator-reach — до скольких операторов вообще дойдёт заявка.
 * Bearer CRON_SECRET, только чтение.
 *
 * Зачем. Заявка с сайта уходит оператору в MAX или Telegram
 * (lib/notifications/operator-booking). Ветка отправки требовала хотя бы один
 * адрес — и до 04.09 не имела `else`: оператор без адресов не получал заявку
 * НИКОГДА, и в логе не было ни строки. Со стороны это неотличимо от «оператор
 * видит бронь и молчит»: Watchdog в таком случае винит оператора, хотя чинить
 * надо у нас.
 *
 * Перепись отвечает на вопрос ДО того, как придёт заявка: у скольких
 * операторов с живыми турами есть канал, и у скольких его нет поимённо.
 *
 * Считаются только операторы, у которых есть что продавать: партнёр без живых
 * туров недостижим безобидно — ему и присылать нечего.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Row {
  id: number;
  name: string;
  live_tours: number;
  has_telegram: boolean;
  has_max: boolean;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<Row>(
      // Оба chat_id — BIGINT (миграции 077 и 145), не текст. Первая редакция
      // обернула telegram_chat_id в TRIM(), и прод ответил
      // «function pg_catalog.btrim(bigint) does not exist»: перепись упала
      // целиком. Пустой строки у BIGINT не бывает — «есть канал» это просто
      // NOT NULL. Тип колонки читается из миграции, а не предполагается по
      // имени.
      `SELECT p.id,
              p.name,
              COUNT(t.id)::int              AS live_tours,
              (p.telegram_chat_id IS NOT NULL) AS has_telegram,
              (p.max_chat_id IS NOT NULL)      AS has_max
         FROM partners p
         JOIN operator_tours t ON t.operator_id = p.id AND t.is_active = true
        GROUP BY p.id, p.name, p.telegram_chat_id, p.max_chat_id
        ORDER BY COUNT(t.id) DESC`,
    );

    const unreachable = rows.filter((r) => !r.has_telegram && !r.has_max);
    const reachable = rows.length - unreachable.length;

    return NextResponse.json({
      probe: 'operator_reach_v1',
      checked_at: new Date().toISOString(),
      operators_with_live_tours: rows.length,
      reachable,
      unreachable: unreachable.length,
      // Туры недостижимых операторов — это и есть цена молчания: заявка по
      // такому туру создаётся и никуда не едет.
      tours_behind_unreachable: unreachable.reduce((s, r) => s + r.live_tours, 0),
      unreachable_operators: unreachable.map((r) => ({
        id: r.id, name: r.name, live_tours: r.live_tours,
      })),
      verdict: rows.length === 0
        ? 'no_operators'
        : unreachable.length === 0 ? 'all_reachable' : 'gap',
    });
  } catch (err) {
    // Отказ переписи — это «не смог посчитать», а не «все достижимы» (§4.0).
    const message = err instanceof Error ? err.message : String(err);
    console.error('[operator-reach] перепись не выполнена:', message);
    return NextResponse.json(
      { probe: 'operator_reach_v1', verdict: 'unknown', error: message },
      { status: 500 },
    );
  }
}
