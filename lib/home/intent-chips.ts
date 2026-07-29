/**
 * lib/home/intent-chips.ts
 *
 * Чипы быстрого подбора в герое главной.
 *
 * Правило одно: чип — это НАСТОЯЩИЙ фильтр. Если под намерение нет фильтра,
 * который выдача реально применит, чипа не существует. Иначе получается кнопка,
 * которая делает вид, что сузила выбор, а открывает ту же общую ленту.
 *
 * Отсюда два отказа от макета, оба намеренные:
 *   · «С детьми» — честного фильтра нет. Повесить на него ту же `difficulty=easy`,
 *     что и на «Первый раз», значит дать одному выбору два имени.
 *   · «На 3–5 дней» ведёт в планировщик, а не в каталог: фильтра длительности в
 *     `CatalogQuerySchema` НЕТ, `duration_days` лежит в JSONB `payload` с
 *     неизвестным покрытием. Планировщик мыслит днями по-настоящему.
 *
 * Ссылки на типы мест берём из `elementHref()` — того же справочника, по
 * которому живут «Стихии» и десктопный BentoSection. Второй список ссылок на
 * те же вулканы разъехался бы с первым, это уже было.
 */

import { elementHref } from '@/lib/stats/element-groups';

export interface IntentChip {
  /** Стабильный ключ — для аналитики и тестов, не для показа. */
  key: string;
  label: string;
  href: string;
}

export const INTENT_CHIPS: IntentChip[] = [
  { key: 'volcano', label: 'Вулканы',    href: elementHref('fire') },
  { key: 'thermal', label: 'Термальные', href: elementHref('therm') },
  // Маршруты, а не места: «первый раз» — про то, куда пойти, а не что посмотреть.
  { key: 'easy',    label: 'Первый раз', href: '/routes?kind=route&difficulty=easy' },
  { key: 'days',    label: 'На 3–5 дней', href: '/planner' },
];

/** Путь и параметры чипа — общий разбор для UI и сторожа. */
export function chipTarget(chip: IntentChip): { path: string; params: Record<string, string> } {
  const [path, qs = ''] = chip.href.split('?');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) params[k] = v;
  return { path, params };
}
