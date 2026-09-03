/**
 * Guardrails ядра — пределы на ВЕЛИЧИНУ изменения, а не на право его делать.
 *
 * Право решает policy (`policy.ts`: кто, чей ресурс, какое полномочие).
 * Но право менять цену своего тура не отменяет того, что «12000 вместо
 * 120000» — почти всегда опечатка, а не решение. Сверено 03.09 с blueprint
 * commerce-agents Anthropic (`merchant_agent/changes.py`, `check_guardrails`:
 * «items per change, price move, promotion depth»): проверка величины идёт
 * при постановке И при применении, по конфигу, действующему в момент
 * применения. У нас действие применяется сразу, поэтому проверка одна —
 * перед `executeGovernedAction`, — но по той же логике: большой ход
 * возможен, только если человек его ЯВНО подтвердил.
 *
 * Порог — константа, не переменная окружения: правило должно читаться в
 * коде и меняться мержем, а не тихо в панели.
 */

/** Ход цены больше этого процента требует явного подтверждения оператора. */
export const PRICE_MOVE_MAX_PCT = 50;

export type PriceMoveCheck =
  | { ok: true; move_pct: number }
  | { ok: false; move_pct: number | null; reason: string };

/**
 * Три исхода: в пределах порога — ок; за порогом без подтверждения — отказ
 * с названным процентом; за порогом с подтверждением — ок. Нечисловая или
 * неположительная цена — отказ, не «ноль процентов».
 */
export function checkPriceMove(oldPrice: unknown, newPrice: unknown, confirmed: boolean): PriceMoveCheck {
  const oldN = typeof oldPrice === 'number' ? oldPrice : Number(oldPrice);
  const newN = typeof newPrice === 'number' ? newPrice : Number(newPrice);
  if (!Number.isFinite(newN) || newN <= 0) {
    return { ok: false, move_pct: null, reason: 'новая цена должна быть положительным числом' };
  }
  if (!Number.isFinite(oldN) || oldN <= 0) {
    // Старой цены нет или она нулевая — сравнивать не с чем; это не запрет,
    // но и не «в пределах»: пропускаем только с подтверждением.
    return confirmed
      ? { ok: true, move_pct: 0 }
      : { ok: false, move_pct: null, reason: 'у тура нет прежней цены, с которой можно сверить ход — подтвердите изменение явно (confirm_large_move)' };
  }
  const movePct = Math.round(Math.abs(newN - oldN) / oldN * 1000) / 10;
  if (movePct > PRICE_MOVE_MAX_PCT && !confirmed) {
    return {
      ok: false,
      move_pct: movePct,
      reason: `ход цены ${movePct}% (${oldN} → ${newN}) больше порога ${PRICE_MOVE_MAX_PCT}% — похоже на опечатку; если это решение, повторите с confirm_large_move=true`,
    };
  }
  return { ok: true, move_pct: movePct };
}
