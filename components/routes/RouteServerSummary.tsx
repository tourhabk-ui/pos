import Link from 'next/link';

/**
 * Сводка маршрута, которую сервер знает до браузера: имя, описание, точки пути.
 *
 * Аудит SEO 29.09 (Н1): карточка маршрута собиралась только fetch'ем из
 * /api/routes/{id}, а /api/ закрыт в robots.txt. Поисковик, соблюдающий
 * robots, получал «Маршрут не найден» — у 391 из 398 маршрутов в HTML не
 * было ни H1, ни текста. Сводка стоит на месте скелета, пока грузится полная
 * карточка, и остаётся, если полная не пришла: то, что сервер уже прочитал из
 * базы, — факт, и прятать его за «не найден» было бы неправдой.
 */
export interface RouteSummary {
  title: string;
  description: string | null;
  waypoints: Array<{ name: string; slug: string | null }>;
}

export function RouteServerSummary({ summary, note }: { summary: RouteSummary; note?: string | null }) {
  return (
    <article className="ds-page pt-24 pb-10">
      <div className="max-w-3xl mx-auto px-4 space-y-5">
        <p className="text-xs font-semibold text-[var(--accent)]">Маршрут на Камчатке</p>
        <h1
          className="text-3xl sm:text-4xl font-bold text-[var(--text-primary)] leading-tight"
          style={{ fontFamily: 'var(--font-playfair)' }}
        >
          {summary.title}
        </h1>
        {note && <p className="text-sm text-[var(--text-secondary)]">{note}</p>}
        {summary.description && (
          <p className="text-[var(--text-primary)] leading-relaxed whitespace-pre-line">{summary.description}</p>
        )}
        {summary.waypoints.length > 0 && (
          <section className="space-y-2">
            <h2 className="ds-h2">Точки маршрута</h2>
            <ol className="list-decimal pl-5 space-y-1 text-[var(--text-primary)]">
              {summary.waypoints.map((w, i) => (
                <li key={`${w.name}-${i}`}>
                  {w.slug
                    ? <Link href={`/places/${w.slug}`} className="text-[var(--ocean)] hover:underline">{w.name}</Link>
                    : w.name}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </article>
  );
}
