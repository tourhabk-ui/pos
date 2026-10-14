import Link from 'next/link';
import { MapPin, Route, TrendingUp, Eye } from 'lucide-react';
import { locationTypeLabel } from '@/lib/places/location-types';
import type { TrendingPlace, TrendingRoute } from '@/lib/trending/load';
import { plural } from '@/lib/home/data-freshness';
import { difficultyLabel } from '@/lib/tours/labels';

/** Сколько первых снимков грузится сразу: первый ряд сетки на компьютере. */
const EAGER_PHOTOS = 3;

function views(n: number): string {
  return `${n.toLocaleString('ru')} ${plural(n, 'просмотр', 'просмотра', 'просмотров')}`;
}

/** Ноль километров и ноль часов — не данные, а их отсутствие. */
function known(n: number | null): n is number {
  return n != null && n > 0;
}

/**
 * Популярные места и маршруты — оба списка сразу, в серверном HTML (14.10).
 *
 * Прогон 9 переписи: страница отдавала 88 слов. Списки приходили с сервера, но
 * показывались вкладками, и маршруты попадали в разметку только после щелчка —
 * поисковик видел одни места. Заголовок обещал «что смотрят прямо сейчас», а
 * счётчик просмотров — за всё время (lib/trending/load, ORDER BY view_count):
 * описание страницы это уже говорило честно, заголовок — нет.
 *
 * failed — сервер не смог прочитать списки; это не «популярного нет» (§4.0).
 */
export function TrendingLists({ places, routes, failed }: {
  places: TrendingPlace[];
  routes: TrendingRoute[];
  failed: boolean;
}) {
  return (
    <main className="ds-page min-h-screen pb-12">
      <div className="max-w-6xl mx-auto px-4">
        <header className="mb-10">
          <div className="flex items-center gap-2 text-[var(--accent)] font-semibold text-sm uppercase tracking-widest mb-2">
            <TrendingUp className="w-4 h-4" />
            Популярное
          </div>
          <h1 className="ds-h1 mb-3">Популярные места и маршруты Камчатки</h1>
          <p className="text-[var(--text-secondary)] text-lg max-w-2xl">
            Что на Ведаре открывают чаще всего — по числу просмотров карточки за всё время.
          </p>
        </header>

        {failed ? (
          <div className="ds-card p-10 text-center">
            <p className="text-[var(--text-secondary)]">Не удалось загрузить популярное. Обновите страницу.</p>
          </div>
        ) : (
          <div className="space-y-12">
            <section aria-labelledby="trending-places">
              <h2 id="trending-places" className="ds-h2 mb-5 flex items-center gap-2">
                <MapPin className="w-5 h-5 text-[var(--accent)]" /> Места
              </h2>
              {places.length === 0 ? (
                <p className="text-[var(--text-secondary)]">Списка мест пока нет.</p>
              ) : (
                <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                  {places.map((p, idx) => (
                    <li key={p.id}>
                      <Link href={`/places/${p.slug ?? p.id}`} className="ds-card group block h-full hover:shadow-md transition-all duration-200">
                        <div className="relative">
                          {p.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={p.image_url}
                              alt={p.name}
                              loading={idx < EAGER_PHOTOS ? undefined : 'lazy'}
                              decoding="async"
                              className="w-full h-40 object-cover rounded-t-lg"
                            />
                          ) : (
                            <div className="w-full h-40 rounded-t-lg bg-[var(--bg-hover)] flex items-center justify-center">
                              <MapPin className="w-8 h-8 text-[var(--text-muted)]" />
                            </div>
                          )}
                          <span className="absolute top-2 left-2 bg-[var(--accent)] text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center">
                            {idx + 1}
                          </span>
                        </div>
                        <div className="p-4">
                          <p className="text-xs text-[var(--accent)] font-semibold uppercase tracking-wide mb-1">
                            {locationTypeLabel(p.location_type)}
                          </p>
                          <h3 className="font-playfair font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                            {p.name}
                          </h3>
                          <p className="text-xs text-[var(--text-muted)] mt-1 flex items-center gap-1">
                            <Eye className="w-3 h-3" aria-hidden="true" />
                            <span>{views(p.view_count)}</span>
                          </p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section aria-labelledby="trending-routes">
              <h2 id="trending-routes" className="ds-h2 mb-5 flex items-center gap-2">
                <Route className="w-5 h-5 text-[var(--accent)]" /> Маршруты
              </h2>
              {routes.length === 0 ? (
                <p className="text-[var(--text-secondary)]">Списка маршрутов пока нет.</p>
              ) : (
                <ol className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {routes.map((r, idx) => (
                    <li key={r.id}>
                      <Link href={`/routes/${r.slug ?? r.id}`} className="ds-card group block h-full p-4 hover:shadow-md transition-all duration-200">
                        <div className="flex items-start gap-3">
                          <span className="text-[var(--accent)] font-bold text-2xl font-playfair shrink-0 w-8">
                            {idx + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            {r.difficulty && (
                              <span className="ds-badge text-xs mb-1 inline-block">{difficultyLabel(r.difficulty, true)}</span>
                            )}
                            <h3 className="font-playfair font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">
                              {r.title}
                            </h3>
                            <div className="flex gap-3 text-xs text-[var(--text-secondary)] mt-1">
                              {known(r.distance_km) && <span>{r.distance_km} км</span>}
                              {known(r.duration_hours) && <span>{r.duration_hours} ч</span>}
                              <span className="flex items-center gap-1 ml-auto text-[var(--text-muted)]">
                                <Eye className="w-3 h-3" aria-hidden="true" />
                                <span>{views(r.view_count)}</span>
                              </span>
                            </div>
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
