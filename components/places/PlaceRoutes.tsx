import Link from 'next/link';
import { Route, ChevronRight } from 'lucide-react';
import type { PlaceRoute } from './types';

interface Props {
  routes: PlaceRoute[];
  placeId: string;
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'text-[var(--success)]',
  medium: 'text-[var(--warning)]',
  hard: 'text-[var(--danger)]',
};

/**
 * Маршруты места — двумя списками (03.10). Связь «рядом» (миграция 167, «в
 * 15 км от центра маршрута», §4.1) через место не идёт, и под заголовком
 * «Маршруты через это место» она врала: у Батареи Максутова там стояли
 * «Скалы Три Брата» и Халактырский пляж. Расстояния до них в данных нет —
 * поэтому у «рядом» его и не пишется; км в строке — длина самого маршрута.
 */
export default function PlaceRoutes({ routes, placeId: _ }: Props) {
  if (!routes.length) return null;
  const through = routes.filter(r => r.linkKind !== 'nearby');
  const nearby = routes.filter(r => r.linkKind === 'nearby');

  return (
    <>
      {through.length > 0 && <RouteList title="Маршруты через это место" routes={through} />}
      {nearby.length > 0 && (
        <RouteList
          title="Маршруты в окрестностях"
          note="Через само место они не проходят. Километры — длина маршрута, а не расстояние до него."
          routes={nearby}
        />
      )}
    </>
  );
}

function RouteList({ title, note, routes }: { title: string; note?: string; routes: PlaceRoute[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2" style={{ fontFamily: 'var(--font-playfair)' }}>
        <Route className="w-5 h-5 text-[var(--accent)]" /> {title}
      </h2>
      {note && <p className="text-xs text-[var(--text-muted)]">{note}</p>}
      <div className="space-y-2">
        {routes.map(r => (
          <Link
            key={r.id}
            href={`/routes/${r.slug ?? r.id}`}
            className="ds-card p-4 flex items-center justify-between gap-3 hover:border-[var(--accent)] transition-colors group"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                {r.title}
              </p>
              <div className="flex items-center gap-3 mt-1 text-xs text-[var(--text-muted)]">
                {r.difficulty && (
                  <span className={DIFFICULTY_COLORS[r.difficulty] ?? ''}>
                    {r.difficulty}
                  </span>
                )}
                {r.distanceKm != null && <span>длина {r.distanceKm} км</span>}
                {r.durationHours != null && <span>{r.durationHours} ч</span>}
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
          </Link>
        ))}
      </div>
    </section>
  );
}
