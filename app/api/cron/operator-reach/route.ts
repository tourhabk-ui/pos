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
 *
 * ПОПРАВКА 08.09 (владелец: «есть у них и тг и макс»). До этого дня перепись
 * читала ОДНУ колонку — `partners.telegram_chat_id` — и объявляла оператора
 * недостижимым, когда его адрес записан во второй: `users.telegram_id` через
 * `partners.user_id`. Колонки заполняются разными путями (вход через Telegram
 * и `/start link_…`, причём вторая запись сделана под `.catch(() => null)`), и
 * половина живого кода читала одну, половина другую. Теперь адрес спрашивает
 * общий модуль `lib/partners/reach`, тот же самый, которым уходит уведомление:
 * иначе перепись отвечает не про доставку, а про свою колонку.
 *
 * Отсюда третье поле в ответе — `telegram_only_in_user_account`: адрес есть,
 * но не там, где его искала половина платформы. Это не недостижимость, это
 * расхождение колонок, и чинится оно иначе.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { partnerReachCensus } from '@/lib/partners/reach';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;


export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Оба chat_id — BIGINT (миграции 077 и 145), не текст. Первая редакция
    // обернула telegram_chat_id в TRIM(), и прод ответил «function
    // pg_catalog.btrim(bigint) does not exist»: перепись упала целиком.
    // Пустой строки у BIGINT не бывает — «есть канал» это просто NOT NULL.
    const rows = (await partnerReachCensus()).sort((a, b) => b.live_tours - a.live_tours);

    const unreachable = rows.filter((r) => !r.has_telegram && !r.has_max);
    const reachable = rows.length - unreachable.length;
    const onlyInUserAccount = rows.filter((r) => r.telegram_source === 'user');

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
        name: r.name, live_tours: r.live_tours,
      })),
      // Адрес есть, но записан только в аккаунте человека: для брони из чата
      // Кузьмича такой оператор достижим, для брони с сайта до 08.09 не был.
      // Это отдельное состояние, а не «достижим» и не «недостижим».
      telegram_only_in_user_account: onlyInUserAccount.map((r) => ({
        name: r.name, live_tours: r.live_tours,
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
