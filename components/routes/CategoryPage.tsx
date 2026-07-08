import { pool } from '@/lib/db-pool';
import { notFound } from 'next/navigation';
import { CATEGORY_PAGES } from '@/lib/routes/category-meta';
import { ZONE_PAGES, MIN_ITEMS_FOR_PAGE } from '@/lib/routes/zone-meta';
import { Header } from '@/components/layout/Header';
import RouteCard, { RouteItem } from './RouteCard';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

/**
 * SEO-страница категории (/routes/[category]) и её зонного среза
 * (/routes/[category]/[zone]). Правило ≥3: страница с меньшим числом
 * объектов отдаёт 404 и не попадает в sitemap — никакого индексного мусора.
 * Никакого сгенерированного SEO-текста: intro категории написан вручную
 * (category-meta), зонный срез показывает только реальные данные.
 */
export default async function CategoryPage({ category, zone }: { category: string; zone?: string }) {
  const meta = CATEGORY_PAGES[category];
  const zoneMeta = zone ? ZONE_PAGES[zone] : null;
  if (!meta || (zone && !zoneMeta)) notFound();

  const [routeResult, countResult, zonesResult, parksResult] = await Promise.all([
    pool.query<{
      id: string; title: string; description: string; category: string;
      lat: unknown; lng: unknown; price_from: unknown; difficulty: string | null;
      duration_days: unknown; source_name: string | null;
    }>(
      `SELECT id, title, description, category, lat, lng,
              NULLIF(payload->>'price_from', '')::numeric AS price_from,
              payload->>'difficulty' AS difficulty,
              NULLIF(payload->>'duration_days', '')::numeric::int AS duration_days,
              source_name
       FROM agent_route_knowledge
       WHERE category = $1 AND is_visible = TRUE
         AND ($2::text IS NULL OR zone = $2)
       ORDER BY
         CASE WHEN source_name = 'idilesom.com' THEN 0
              WHEN source_name = 'kamchatintour.ru' THEN 1
              ELSE 2 END,
         title ASC
       LIMIT 24`,
      [category, zone ?? null]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agent_route_knowledge
       WHERE category = $1 AND is_visible = TRUE
         AND ($2::text IS NULL OR zone = $2)`,
      [category, zone ?? null]
    ),
    // Живые зонные срезы этой категории — для перелинковки (только ≥3)
    pool.query<{ zone: string; count: string }>(
      `SELECT zone, COUNT(*) AS count FROM agent_route_knowledge
       WHERE category = $1 AND is_visible = TRUE AND zone IS NOT NULL
       GROUP BY zone`,
      [category]
    ),
    // Парки-согласователи зоны — для блока «Разрешения» на зонном срезе
    // (issue #367); для страницы категории без зоны не запрашиваются
    zone
      ? pool.query<{ slug: string; display_name: string }>(
          `SELECT slug, display_name FROM parks
           WHERE zone = $1 AND is_active = true
           ORDER BY display_name`,
          [zone]
        )
      : Promise.resolve({ rows: [] as { slug: string; display_name: string }[] }),
  ]);

  const total = Number(countResult.rows[0].count);
  // Правило ≥3 — тонкие страницы отдают 404
  if (total < MIN_ITEMS_FOR_PAGE) notFound();

  const routes: RouteItem[] = routeResult.rows.map(r => ({
    id: r.id,
    category: r.category,
    title: r.title,
    description: r.description,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    priceFrom: r.price_from != null ? Number(r.price_from) : null,
    difficulty: r.difficulty,
    durationDays: r.duration_days != null ? Number(r.duration_days) : null,
    sourceName: r.source_name,
  }));

  const otherCategories = Object.values(CATEGORY_PAGES).filter(c => c.slug !== category);
  const liveZones = zonesResult.rows
    .filter(z => Number(z.count) >= MIN_ITEMS_FOR_PAGE && ZONE_PAGES[z.zone])
    .map(z => ({ ...ZONE_PAGES[z.zone], count: Number(z.count) }));

  const h1 = zoneMeta ? `${meta.name}: ${zoneMeta.name}` : meta.h1;
  const zoneParks = parksResult.rows;

  return (
    <>
      <Header />
      <div className="ds-page pt-20 pb-10">

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] mb-6">
          <Link href="/" className="hover:text-[var(--accent)] transition-colors">Главная</Link>
          <ChevronRight className="w-3 h-3" />
          <Link href="/routes" className="hover:text-[var(--accent)] transition-colors">Маршруты</Link>
          <ChevronRight className="w-3 h-3" />
          {zoneMeta ? (
            <>
              <Link href={`/routes/${category}`} className="hover:text-[var(--accent)] transition-colors">{meta.name}</Link>
              <ChevronRight className="w-3 h-3" />
              <span className="text-[var(--text-primary)]">{zoneMeta.name}</span>
            </>
          ) : (
            <span className="text-[var(--text-primary)]">{meta.name}</span>
          )}
        </nav>

        {/* Hero: intro — только рукописный текст категории, зонный срез без
            сочинённых текстов, только реальные данные */}
        <div className="mb-8 max-w-2xl">
          <h1 className="ds-h1 mb-3">{h1}</h1>
          {!zoneMeta && (
            <p className="text-[var(--text-secondary)] leading-relaxed text-base">{meta.intro}</p>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-3 mb-6 text-sm">
          <span className="text-[var(--text-muted)]">{total} маршрутов</span>
          {/* Ссылка «все» только на странице категории: листинг /routes
              не умеет фильтровать по зоне, для среза она обманула бы счётчиком */}
          {!zoneMeta && total > 24 && (
            <>
              <span className="text-[var(--border)]">·</span>
              <Link
                href={`/routes?category=${category}`}
                className="text-[var(--accent)] hover:underline"
              >
                Смотреть все {total} →
              </Link>
            </>
          )}
        </div>

        {/* Зонные срезы категории (перелинковка; только живые, ≥3) */}
        {liveZones.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-8">
            {zoneMeta && (
              <Link
                href={`/routes/${category}`}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
              >
                Все зоны
              </Link>
            )}
            {liveZones.filter(z => z.slug !== zone).map(z => (
              <Link
                key={z.slug}
                href={`/routes/${category}/${z.slug}`}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
              >
                {z.name} · {z.count}
              </Link>
            ))}
          </div>
        )}

        {/* Разрешения в этой зоне: парки-согласователи (issue #367).
            Только реальные данные из parks — нет парков, нет блока */}
        {zoneMeta && zoneParks.length > 0 && (
          <div className="mb-8 p-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg max-w-2xl">
            <p className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              Разрешения в этой зоне
            </p>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              Часть маршрутов проходит по особо охраняемым территориям — посещение согласуется с дирекцией парка.
            </p>
            <div className="flex flex-wrap gap-2">
              {zoneParks.map(p => (
                <Link
                  key={p.slug}
                  href={`/park/${p.slug}`}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
                >
                  {p.display_name}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-10">
          {routes.map(r => (
            <RouteCard key={r.id} route={r} />
          ))}
          {routes.length === 0 && (
            <p className="col-span-full text-[var(--text-muted)] text-sm py-8 text-center">
              Маршруты не найдены
            </p>
          )}
        </div>

        {/* Other categories */}
        <div className="border-t border-[var(--border)] pt-8">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">
            Другие виды туров на Камчатке
          </h2>
          <div className="flex flex-wrap gap-2">
            {otherCategories.map(c => (
              <Link
                key={c.slug}
                href={`/routes/${c.slug}`}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>

      </div>
    </>
  );
}
