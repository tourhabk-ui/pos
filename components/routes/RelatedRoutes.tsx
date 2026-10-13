import Link from 'next/link';
import RouteCard, { type RouteItem } from '@/components/routes/RouteCard';

/**
 * «Похожие маршруты» карточки маршрута (§10, блок 12). Список приходит с
 * сервера (lib/routes/related — соседи по кольцу в группе того же занятия),
 * поэтому ссылки на соседей есть в первом HTML. Пусто — блока нет.
 */
export function RelatedRoutes({ routes, activityType }: { routes: RouteItem[]; activityType: string | null }) {
  if (routes.length === 0) return null;
  // Без занятия — весь список: «?activity_type=» с пустым значением ничего не фильтрует.
  const allHref = activityType ? `/routes?activity_type=${encodeURIComponent(activityType)}` : '/routes';
  return (
    <div className="mt-16 pt-8 border-t border-[var(--border)]">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Похожие маршруты</h2>
        <Link href={allHref} className="text-sm text-[var(--ocean)] hover:underline">
          Все →
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {routes.map((r) => <RouteCard key={r.id} route={r} />)}
      </div>
    </div>
  );
}
