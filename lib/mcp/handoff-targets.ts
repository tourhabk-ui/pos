/**
 * Handoff-цели инструментов MCP (v2, задача #60): куда человеку продолжить
 * на Ведаре после ответа агента.
 *
 * Правила:
 *  - Пути строит ТОЛЬКО этот серверный код по белому списку isSafeTarget —
 *    URL из аргументов внешнего агента не берётся никогда.
 *  - Сущность (тур, место) резолвится ТЕМИ ЖЕ функциями, какими её находит
 *    сам инструмент (resolveTourChoice, resolvePlaceForLink) — одна мера в
 *    одном месте: ссылка ведёт на то, о чём инструмент ответил, а не на
 *    результат второго, чуть другого поиска.
 *  - Не нашли сущность — нет ссылки. Ссылка «на каталог вообще» после
 *    вопроса о конкретном туре хуже отсутствия ссылки.
 *  - Запрос подошёл турам нескольких компаний (слово владельца 29.10) —
 *    ссылки на ОДИН тур нет: она выбрала бы продавца за человека. Все
 *    кандидаты идут к одному записанному месту — ссылка на «Туры к этому
 *    месту» его карточки, где они все по правилу 1в; иначе ссылки нет.
 *  - Запрос назвал продавца или совпал лишь частью слов (ловушка 29.10,
 *    name-search) — ссылки нет: тур не выбран.
 */

import type { HandoffTarget } from '@/lib/mcp/handoff';
import { resolveTourChoice, type TourChoice } from '@/lib/kuzmich/tour-availability-tool';
import { ruPlacePath } from '@/lib/zh/pages';
import { tourPath } from '@/lib/tours/tour-url';
import { parsePlanStart, planIdFromAnswer } from '@/lib/kuzmich/trip-plan-tool';
import { resolvePlaceForLink } from '@/lib/kuzmich/guardian-context';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Куда вести после ответа о туре: один тур — его карточка; несколько компаний
 * — общее место или никуда. Продавец и частичное совпадение слов — никуда:
 * тур не выбран, а ссылка на один тур выбрала бы его за человека. Страница
 * продавца стоит полным адресом в тексте ответа (цели «продавец» у handoff нет).
 */
export function tourChoiceTarget(choice: TourChoice): HandoffTarget | null {
  if (choice.kind === 'one') return { targetType: 'tour', targetPath: tourPath(choice.tour) };
  if (choice.kind !== 'ambiguous') return null;
  const first = choice.candidates[0]?.place ?? null;
  if (!first) return null;
  const samePlace = choice.candidates.every((c) => c.place?.id === first.id);
  return samePlace ? { targetType: 'place', targetPath: `${ruPlacePath(first)}#tours` } : null;
}

export async function handoffTargetForTool(
  toolName: string,
  args: Record<string, unknown>,
  /** Ответ самого инструмента: id сохранённого плана берётся из него, не из аргументов агента. */
  answer = '',
): Promise<HandoffTarget | null> {
  switch (toolName) {
    case 'make_trip_plan': {
      // План сохранён черновиком — человек продолжает на странице ЭТОГО плана
      // (#2225): карта, GPX, сохранение для офлайна. Планер по тем же
      // аргументам собрал бы план заново, и дни могли бы разойтись с ответом.
      const planId = planIdFromAnswer(answer);
      if (planId) return { targetType: 'plan', targetPath: `/trip/${planId}` };
      const query = new URLSearchParams();
      const days = str(args.days);
      if (/^\d{1,2}$/.test(days)) query.set('days', days);
      const interests = str(args.interests);
      if (interests) query.set('interests', interests.slice(0, 120));
      // Дата старта — та же, на которую посчитан план (parsePlanStart из
      // when). Без неё планер по ссылке ставил старт «через месяц», и план на
      // июль 2027 открывался на другие даты (проверка MCP 29.09, T17).
      const start = parsePlanStart(str(args.when) || undefined, Date.now());
      if (start.kind !== 'default') query.set('from', start.date.toISOString().slice(0, 10));
      const qs = query.toString();
      return { targetType: 'planner', targetPath: `/planner${qs ? `?${qs}` : ''}` };
    }

    case 'safety_status':
      return { targetType: 'safety', targetPath: '/safety' };

    // Аргументы читаются так же, как их читает сам инструмент в core.ts.
    case 'get_tour_details': {
      const q = str(args.name) || str(args.query);
      if (!q) return null;
      return tourChoiceTarget(await resolveTourChoice(q));
    }

    case 'get_tour_availability': {
      const q = str(args.tour);
      if (!q) return null;
      return tourChoiceTarget(await resolveTourChoice(q));
    }

    case 'get_guardian_context':
    case 'get_place_info': {
      const q = str(args.place) || str(args.name);
      if (!q) return null;
      const placeId = await resolvePlaceForLink(q);
      return placeId ? { targetType: 'place', targetPath: `/places/${placeId}` } : null;
    }

    case 'edit_trip_plan': {
      // Правка записана — ссылка на тот же план со свежей правкой. Правка не
      // удалась или плана нет — в ответе нет id, и ссылки нет.
      const planId = planIdFromAnswer(answer);
      return planId ? { targetType: 'plan', targetPath: `/trip/${planId}` } : null;
    }
    default:
      return null;
  }
}
