/**
 * GET /api/eco/wallet — кошелёк эко держателя.
 *
 * Один источник вместо трёх. До этого баланс «баллов» одного туриста жил в
 * трёх независимых местах: eco_ledger (реестр), loyalty_transactions (архив) и
 * user_eco_points — таблица, которую читал экран эко-баллов и которую НЕ
 * создаёт ни одна миграция (только неприменяемый lib/database/schema.sql). Тот
 * же дефект, что чинила миграция 713 для лояльности: запрос падал, экран
 * честно показывал ноль — просто потому, что читать было неоткуда.
 *
 * Отдаёт всё, что нужно витрине, чтобы ничего не пришлось досочинять:
 *  - вклад и польза раздельно (docs/ECO.md, два слоя);
 *  - история проводок;
 *  - прейскурант ИЗ ПРАВИЛ, а не из списка в JSX — иначе он снова разойдётся
 *    с реальностью, как разошёлся прежний экран (обещал 100 за уборку,
 *    которой нет источника, и 30 за фото, которое стоит 20);
 *  - стоки с текущей долей чека и тем, кто её сейчас компенсирует.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getBalance, getContribution, getHistory } from '@/lib/eco/ledger';
import { EMISSION_RULES, DAILY_USER_CAP } from '@/lib/eco/emission';
import { ECO_SINKS } from '@/lib/eco/sinks';
import { currentTerms } from '@/lib/eco/compensation';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (!auth.isAuthenticated || !auth.userId) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  try {
    const [utility, contribution, history, terms] = await Promise.all([
      getBalance(auth.userId),
      getContribution(auth.userId),
      getHistory(auth.userId, 20),
      currentTerms().catch(() => null),
    ]);

    // Прейскурант строится из действующих правил. Начисление за заказ считается
    // от суммы чека, поэтому фиксированной цены у него нет — так и пишем.
    const earning = Object.values(EMISSION_RULES).map((rule) => ({
      source: rule.source,
      description: rule.description,
      amount: rule.amount > 0 ? rule.amount : null,
      perDayLimit: rule.perDayLimit,
      oncePerUser: rule.oncePerUser ?? false,
      requiresModeration: rule.requiresModeration ?? false,
    }));

    const spending = Object.values(ECO_SINKS).map((sink) => ({
      key: sink.key,
      label: sink.label,
      description: sink.description,
      maxShareOfCheck: terms?.sinks[sink.key]?.maxShareOfCheck ?? sink.maxShareOfCheck.platform,
    }));

    return NextResponse.json({
      success: true,
      data: {
        // Вклад не тратится и не сгорает — это накопленная история поступков.
        contribution,
        // Польза тратится на скидку и сгорает по сроку.
        utility,
        history,
        earning,
        dailyCap: DAILY_USER_CAP,
        spending,
        // Кто сейчас компенсирует скидку — часть честного ответа на вопрос
        // «сколько я могу потратить».
        payer: terms?.payer ?? null,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Не удалось загрузить кошелёк эко' }, { status: 500 });
  }
}
