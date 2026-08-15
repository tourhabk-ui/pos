/**
 * Handoff-цели инструментов MCP (v2, задача #60): куда человеку продолжить
 * на Ведаре после ответа агента.
 *
 * Правила:
 *  - Пути строит ТОЛЬКО этот серверный код по белому списку isSafeTarget —
 *    URL из аргументов внешнего агента не берётся никогда.
 *  - Сущность (тур, место) резолвится ТЕМИ ЖЕ функциями, какими её находит
 *    сам инструмент (resolveTourByQuery, resolvePlaceForLink) — одна мера в
 *    одном месте: ссылка ведёт на то, о чём инструмент ответил, а не на
 *    результат второго, чуть другого поиска.
 *  - Не нашли сущность — нет ссылки. Ссылка «на каталог вообще» после
 *    вопроса о конкретном туре хуже отсутствия ссылки.
 */

import type { HandoffTarget } from '@/lib/mcp/handoff';
import { resolveTourByQuery } from '@/lib/kuzmich/tour-availability-tool';
import { resolvePlaceForLink } from '@/lib/kuzmich/guardian-context';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export async function handoffTargetForTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<HandoffTarget | null> {
  switch (toolName) {
    case 'make_trip_plan': {
      const query = new URLSearchParams();
      const days = str(args.days);
      if (/^\d{1,2}$/.test(days)) query.set('days', days);
      const interests = str(args.interests);
      if (interests) query.set('interests', interests.slice(0, 120));
      const qs = query.toString();
      return { targetType: 'planner', targetPath: `/planner${qs ? `?${qs}` : ''}` };
    }

    case 'safety_status':
      return { targetType: 'safety', targetPath: '/safety' };

    // Аргументы читаются так же, как их читает сам инструмент в core.ts.
    case 'get_tour_details': {
      const q = str(args.name) || str(args.query);
      if (!q) return null;
      const tour = await resolveTourByQuery(q);
      return tour ? { targetType: 'tour', targetPath: `/catalog/tours/${tour.id}` } : null;
    }

    case 'get_tour_availability': {
      const q = str(args.tour);
      if (!q) return null;
      const tour = await resolveTourByQuery(q);
      return tour ? { targetType: 'tour', targetPath: `/catalog/tours/${tour.id}` } : null;
    }

    case 'get_guardian_context':
    case 'get_place_info': {
      const q = str(args.place) || str(args.name);
      if (!q) return null;
      const placeId = await resolvePlaceForLink(q);
      return placeId ? { targetType: 'place', targetPath: `/places/${placeId}` } : null;
    }

    default:
      return null;
  }
}
