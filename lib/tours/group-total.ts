/**
 * Итог за группу словами — одни слова для всех ответов агенту (Кузьмич, MCP).
 *
 * Итог считается в одном месте — groupTotalOn (lib/kuzmich/tour-availability-tool,
 * тем же расчётом, что у самой брони), а называется здесь: окно дат
 * get_tour_availability и сравнение туров compare_tours говорят одно и то же
 * одинаково. Четыре исхода, а не два (§4.0): сумма; группа вне ступеней цены —
 * цену называет оператор (повторять бесполезно); цены у тура нет; расчёт не
 * удался (можно повторить). Модуль чистый — без базы.
 */

/** Итог за группу на дату: сумма, группа вне ступеней цены, цены нет или сбой расчёта. */
export type GroupTotal =
  | { kind: 'total'; total: number }
  | { kind: 'tier_miss' }
  | { kind: 'no_price' }
  | { kind: 'failed' };

/** «30 000 ₽» — рубли целыми, с разрядами. */
export const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Итог словами — одни слова для окна дат и для сравнения. */
export function groupTotalLabel(t: GroupTotal, people: number): string {
  switch (t.kind) {
    case 'total': return `итого за ${people} чел.: ${rub(t.total)}`;
    case 'tier_miss': return `для группы из ${people} чел. цену называет оператор`;
    case 'no_price': return 'цену называет оператор';
    case 'failed': return 'итог не посчитан';
  }
}
