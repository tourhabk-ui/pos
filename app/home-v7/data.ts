/**
 * Серверный data-слой Главной v8 «Воронка».
 * Все блоки, что выглядят как приборы, тянут РЕАЛЬНЫЕ данные — иначе блока нет.
 * Источники подтверждены по коду:
 *   - external_alerts        → лента безопасности (severity/title/type/expires)
 *   - volcano_status (KVERT) → ACC-статус вулканов (aviation_color_code)
 *   - location_real_time_status → открыто/закрыто зон + свежесть
 *   - queryCatalog           → платы «Куда сегодня» (фото, цена, категория)
 *   - operator_bookings …    → живой журнал
 *   - places counts          → «Стихии» и «В цифрах»
 * Каждая выборка в своём try/catch: сбой одного блока не роняет страницу.
 */

import { query } from '@/lib/database';
import { queryCatalog, type CatalogItem } from '@/lib/routes/catalog-query';
import { getSeismicFeed, type SeismicEvent } from '@/lib/services/seismic-feed';

export interface SafetyAlert {
  title: string;
  type: string | null;
  severity: number;
  at: string | null;
}
export interface ElevatedVolcano {
  name: string;
  acc: string; // yellow|orange|red
}
export interface SafetySnapshot {
  activeCount: number;
  maxSeverity: number;
  alerts: SafetyAlert[];
  volcanoes: ElevatedVolcano[];
  updatedAt: string | null;
}
export interface ZonesSnapshot {
  open: number;
  total: number;
  updatedAt: string | null;
}
export interface Plate {
  id: string;
  kind: string;
  title: string;
  description: string;
  imageUrl: string | null;
  priceFrom: number | null;
  category: string;
  locationType: string | null;
  volcanoStatus: string | null;
}
export interface FeedItem { text: string }
export interface Stat { value: string; label: string; href?: string }
export interface Element { key: string; label: string; count: number; href: string }
export interface Quake { magnitude: number; place: string; time: number; depth: number | null }
export interface SeismicSnapshot { events: Quake[]; source: 'kbgsras' | 'usgs' | 'none'; updatedAt: string | null }

export interface HomeV8Data {
  safety: SafetySnapshot;
  seismic: SeismicSnapshot;
  zones: ZonesSnapshot;
  plates: Plate[];
  feed: FeedItem[];
  stats: Stat[];
  elements: Element[];
}

const ACC_RANK: Record<string, number> = { red: 3, orange: 2, yellow: 1 };

async function fetchSafety(): Promise<SafetySnapshot> {
  try {
    const [alertsRes, volcRes, freshRes] = await Promise.all([
      query<{ title: string; alert_type: string | null; severity: number; created_at: string }>(
        `SELECT title, alert_type, severity::int AS severity, created_at::text
           FROM external_alerts
          WHERE expires_at > NOW()
          ORDER BY severity DESC, created_at DESC
          LIMIT 5`,
      ),
      query<{ name: string; acc: string }>(
        `SELECT p.name, vs.aviation_color_code AS acc
           FROM volcano_status vs
           JOIN places p ON vs.place_ark_id = p.ark_id
          WHERE vs.aviation_color_code IN ('yellow','orange','red')
            AND p.is_visible = TRUE
          LIMIT 12`,
      ),
      query<{ last_update: string | null }>(
        `SELECT MAX(updated_at)::text AS last_update FROM location_real_time_status`,
      ),
    ]);

    const alerts = alertsRes.rows.map((r) => ({
      title: r.title,
      type: r.alert_type,
      severity: r.severity ?? 0,
      at: r.created_at,
    }));
    const volcanoes = volcRes.rows
      .map((r) => ({ name: r.name, acc: r.acc }))
      .sort((a, b) => (ACC_RANK[b.acc] ?? 0) - (ACC_RANK[a.acc] ?? 0));

    return {
      activeCount: alerts.length,
      maxSeverity: alerts.reduce((m, a) => Math.max(m, a.severity), 0),
      alerts,
      volcanoes,
      updatedAt: freshRes.rows[0]?.last_update ?? null,
    };
  } catch {
    return { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null };
  }
}

async function fetchZones(): Promise<ZonesSnapshot> {
  try {
    const r = await query<{ open: string; total: string; last_update: string | null }>(
      `SELECT COUNT(*) FILTER (WHERE is_open IS TRUE)::text AS open,
              COUNT(*)::text                          AS total,
              MAX(updated_at)::text                   AS last_update
         FROM location_real_time_status`,
    );
    const row = r.rows[0];
    return {
      open: parseInt(row?.open ?? '0'),
      total: parseInt(row?.total ?? '0'),
      updatedAt: row?.last_update ?? null,
    };
  } catch {
    return { open: 0, total: 0, updatedAt: null };
  }
}

async function fetchPlates(): Promise<Plate[]> {
  try {
    // Туры (коммерческий продукт) с ценой и фото — то, что реально можно купить.
    const res = await queryCatalog({
      kind: 'tour', page: 1, limit: 6, sort: 'recommended', hasCoords: 'false',
    } as Parameters<typeof queryCatalog>[0]);
    let items: CatalogItem[] = res.items;
    // Если туров мало — добираем маршрутами (тоже с фото), чтобы витрина не пустовала.
    if (items.length < 4) {
      const routes = await queryCatalog({
        kind: 'route', page: 1, limit: 6, sort: 'recommended', hasCoords: 'false',
      } as Parameters<typeof queryCatalog>[0]);
      items = [...items, ...routes.items].slice(0, 6);
    }
    return items.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      description: (i.description || '').slice(0, 140),
      imageUrl: i.imageUrl ?? null,
      priceFrom: i.priceFrom ?? null,
      category: i.category,
      locationType: i.locationType,
      volcanoStatus: i.volcanoStatus,
    }));
  } catch {
    return [];
  }
}

async function fetchFeed(): Promise<FeedItem[]> {
  try {
    const res = await query<{ tour_title: string; operator_name: string; created_at: string }>(
      `SELECT ot.title AS tour_title, p.name AS operator_name, ob.created_at::text
         FROM operator_bookings ob
         JOIN operator_tours ot ON ob.operator_tour_id = ot.id
         JOIN partners p ON ot.operator_id = p.id
        WHERE ob.booking_status IN ('confirmed','new')
          AND ob.created_at > NOW() - '72 hours'::interval
        ORDER BY ob.created_at DESC
        LIMIT 6`,
    );
    return res.rows.map((r) => ({
      text: `Заявка на «${r.tour_title}» · ${r.operator_name}`,
    }));
  } catch {
    return [];
  }
}

async function fetchStats(): Promise<Stat[]> {
  try {
    const [routes, places, mchs] = await Promise.all([
      query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM kamchatka_routes`),
      query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM places WHERE is_visible = TRUE`),
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM kamchatka_routes WHERE mchs_registration_required = TRUE`,
      ),
    ]);
    return [
      { value: routes.rows[0]?.n ?? '0', label: 'маршрута', href: '/routes' },
      { value: places.rows[0]?.n ?? '0', label: 'локация', href: '/routes?kind=place' },
      { value: mchs.rows[0]?.n ?? '0', label: 'рег. МЧС' },
      { value: '24/7', label: 'SAR' },
    ];
  } catch {
    return [{ value: '24/7', label: 'SAR' }];
  }
}

// Стихии → группы location_type. Каждая ведёт в каталог с фильтром.
const ELEMENT_GROUPS: Array<{ key: string; label: string; types: string[]; href: string }> = [
  { key: 'fire',   label: 'Огонь',   types: ['volcano'],                          href: '/routes?location_type=volcano' },
  { key: 'snow',   label: 'Снег',    types: ['mountain', 'glacier', 'pass'],      href: '/routes?location_type=mountain' },
  { key: 'ocean',  label: 'Океан',   types: ['bay', 'coast', 'cape', 'island'],   href: '/routes?location_type=bay' },
  { key: 'therm',  label: 'Термы',   types: ['hot_spring', 'geyser'],             href: '/routes?location_type=hot_spring' },
  { key: 'nature', label: 'Природа', types: ['lake', 'river', 'waterfall', 'valley', 'nature'], href: '/routes?location_type=lake' },
];

async function fetchElements(): Promise<Element[]> {
  try {
    const res = await query<{ location_type: string | null; n: string }>(
      `SELECT location_type, COUNT(*)::text AS n
         FROM places
        WHERE is_visible = TRUE AND location_type IS NOT NULL
        GROUP BY location_type`,
    );
    const byType = new Map<string, number>();
    for (const r of res.rows) byType.set((r.location_type || '').toLowerCase(), parseInt(r.n));
    return ELEMENT_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      href: g.href,
      count: g.types.reduce((sum, t) => sum + (byType.get(t) ?? 0), 0),
    })).filter((e) => e.count > 0);
  } catch {
    return [];
  }
}

async function fetchSeismic(): Promise<SeismicSnapshot> {
  try {
    const feed = await getSeismicFeed();
    const events: Quake[] = feed.events
      .filter((e: SeismicEvent) => Number.isFinite(e.magnitude) && e.magnitude > 0)
      .slice(0, 4)
      .map((e) => ({ magnitude: e.magnitude, place: e.place, time: e.time, depth: e.depth }));
    return { events, source: feed.source, updatedAt: feed.updatedAt };
  } catch {
    return { events: [], source: 'none', updatedAt: null };
  }
}

export async function getHomeV8Data(): Promise<HomeV8Data> {
  const [safety, seismic, zones, plates, feed, stats, elements] = await Promise.all([
    fetchSafety(), fetchSeismic(), fetchZones(), fetchPlates(), fetchFeed(), fetchStats(), fetchElements(),
  ]);
  return { safety, seismic, zones, plates, feed, stats, elements };
}
