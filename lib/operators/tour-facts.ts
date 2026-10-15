/**
 * Чем компания занимается — по её живым турам, а не по чьему-то слову.
 *
 * Находка аудита 15.10 PAVEL-operators. Оператор «Местечко Камчатка» (Павел)
 * через владельца: «зашёл… там 5 туркомпаний… я там не выделяюсь. У меня
 * основное — вертолётные экскурсии». На витрине /operators карточка
 * компании несла только обложку и короткое описание — из неё нельзя было
 * узнать, что пять из семи вертолётных туров платформы его.
 *
 * Строка фактов: число живых туров и разбивка по видам с числами —
 * «15 туров · Джип-сафари 8 · Вертолёт 5 · Снегоход 2». «Специализацию»
 * одним словом намеренно НЕ выводим: у Местечка джипов 8, вертолётов 5 —
 * одно слово соврало бы про любую из двух половин.
 *
 * Подписи — из единого словаря `lib/tours/labels` (короткий регистр, как на
 * чипах каталога): своих слов для видов здесь нет. Модуль чистый — его
 * читают и сервер (`lib/operators/list-query`), и клиент витрины.
 */

import { activityLabel } from '@/lib/tours/labels';
import { plural } from '@/lib/home/data-freshness';

/** Сколько живых туров у компании и какого вида. */
export interface OperatorTourFacts {
  total: number;
  /** По убыванию числа, при равенстве — по подписи. Тур без вида в total входит, сюда — нет. */
  byActivity: { activity_type: string; count: number }[];
}

/** Вид тура и сколько у него… (туров у компании либо компаний на витрине). */
export interface ActivityCount {
  activity_type: string;
  count: number;
}

/** По убыванию числа, при равенстве — по подписи (как её видит человек). */
export function sortActivityCounts(list: ActivityCount[]): ActivityCount[] {
  return [...list].sort((a, b) =>
    b.count - a.count
    || activityLabel(a.activity_type, true).localeCompare(activityLabel(b.activity_type, true), 'ru'));
}

/**
 * Свёртка строк `GROUP BY operator_id, activity_type` в факты по компаниям.
 * Компании без живых туров в строках нет — у неё будет `{ total: 0 }`,
 * это решает вызывающий (он знает, кого спрашивал).
 */
export function summarizeOperatorTourRows(
  rows: { operator_id: string; activity_type: string | null; n: number | string }[],
): Map<string, OperatorTourFacts> {
  const acc = new Map<string, { total: number; byActivity: ActivityCount[] }>();
  for (const r of rows) {
    const n = Number(r.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    const cur = acc.get(r.operator_id) ?? { total: 0, byActivity: [] };
    cur.total += n;
    if (r.activity_type) cur.byActivity.push({ activity_type: r.activity_type, count: n });
    acc.set(r.operator_id, cur);
  }
  const out = new Map<string, OperatorTourFacts>();
  for (const [id, f] of acc) out.set(id, { total: f.total, byActivity: sortActivityCounts(f.byActivity) });
  return out;
}

/**
 * Строка для карточки. `null` — строки нет: живых туров ноль (не «0 туров»)
 * либо посчитать не удалось (`facts === null`, отказ уже в логе сервера).
 */
export function tourFactsLine(facts: OperatorTourFacts | null | undefined): string | null {
  if (!facts || facts.total <= 0) return null;
  const head = `${facts.total} ${plural(facts.total, 'тур', 'тура', 'туров')}`;
  const kinds = facts.byActivity.map((a) => `${activityLabel(a.activity_type, true)} ${a.count}`);
  return [head, ...kinds].join(' · ');
}
