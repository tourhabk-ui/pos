/**
 * Процент для экрана: «0,0 %» и «12,5 %». Число уже в процентах
 * (0.5 — это половина процента, не 50%). Пробел перед знаком — как в
 * аналитике оператора.
 */
export function formatRuPercent(value: number, fractionDigits: 1 | 2 = 1): string {
  const n = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
  return `${n} %`;
}
