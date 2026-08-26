/**
 * GET /api/search
 * Унифицированный поиск: маршруты + места + инструменты.
 * Используется GlobalSearchModal (Ctrl+K).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { semanticSearch } from '@/lib/ai/embeddings';
import { MATCHES_NAME_OR_ALIAS, NOT_MERGED } from '@/lib/places/aliases';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  q:     z.string().max(120).min(1),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

const LOCATION_LABELS: Record<string, string> = {
  volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Источник',
  mountain: 'Гора', geyser: 'Гейзер', valley: 'Долина',
  coast: 'Побережье', river: 'Река', forest: 'Лес', pass: 'Перевал',
};

const CATEGORY_LABELS: Record<string, string> = {
  vulkani: 'Вулканы', morskie_progulki: 'Море', medvedi: 'Медведи',
  snegohod: 'Снегоход', rybalka: 'Рыбалка', trekking: 'Треккинг',
  geyzery: 'Гейзеры', termalnye_istochniki: 'Термы', splav: 'Сплав',
  vertoletnye_tury: 'Вертолёт', dzhip: 'Джип', eco: 'Эко',
};

const STATIC_TOOLS = [
  { id: 'equipment', title: 'Чек-лист снаряжения', subtitle: 'AI-список вещей по маршруту и дате', href: '/tools/equipment' },
  { id: 'safety-tool', title: 'Анализатор безопасности', subtitle: 'Оценка рисков для конкретного места', href: '/tools/safety' },
  { id: 'ai-assistant', title: 'Спросить Кузьмича', subtitle: 'AI-ассистент по Камчатке', href: '/ai-assistant' },
];

const STATIC_PAGES = [
  { id: 'map', title: 'Карта Камчатки', subtitle: 'Интерактивная карта маршрутов', href: '/map' },
  { id: 'safety', title: 'Безопасность', subtitle: 'Статус вулканов и МЧС', href: '/safety' },
  { id: 'routes', title: 'Все маршруты', subtitle: 'Каталог маршрутов', href: '/routes' },
  { id: 'marketplace', title: 'Туры', subtitle: 'Маркетплейс операторов', href: '/marketplace' },
];

export async function GET(request: NextRequest) {
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные параметры' }, { status: 400 });
  }

  const { q, limit } = parsed.data;
  const perType = Math.ceil(limit / 2);
  const pattern = `%${q}%`;

  // Маршруты: сначала семантика (embeddings — «где увидеть медведей» находит
  // релевантное, а не только совпадение букв), при ошибке/пустоте — ILIKE.
  // Порядок сохраняется по убыванию схожести.
  async function findRoutes(): Promise<Array<Record<string, unknown>>> {
    if (q.length >= 3) {
      try {
        const hits = await semanticSearch(q, perType * 3);
        if (hits.length > 0) {
          const { rows } = await query(
            `SELECT id, title, category, location_type, kind
             FROM agent_route_knowledge
             WHERE id = ANY($1::uuid[]) AND is_visible = TRUE`,
            [hits.map(h => h.id)]
          );
          const byId = Object.fromEntries(rows.map(r => [r.id as string, r]));
          const semanticRoutes = hits
            .filter(h => byId[h.id] && (byId[h.id].kind as string) === 'route')
            .slice(0, perType)
            .map(h => byId[h.id]);
          if (semanticRoutes.length > 0) return semanticRoutes;
        }
      } catch {
        // семантика недоступна (нет эмбеддингов/модели) → честный ILIKE ниже
      }
    }
    // id — в пространстве VIEW agent_route_knowledge (COALESCE(ark_id, id)),
    // не голый kamchatka_routes.id: href строится из этого id и ведёт на
    // /routes/[id], который ищет по VIEW. Голый id у маршрута с заполненным
    // ark_id там не находился — 404 из глобального поиска (Ctrl+K). Тот же
    // разбор и та же формула уже стоят в /api/routes/search/route.ts —
    // здесь просто не были применены.
    const { rows } = await query(
      `SELECT COALESCE(ark_id, id) AS id, title, category, location_type
       FROM kamchatka_routes
       WHERE is_visible = TRUE AND merged_into_id IS NULL AND title ILIKE $1
       ORDER BY
         CASE WHEN title ILIKE $2 THEN 0 ELSE 1 END,
         LENGTH(title) ASC
       LIMIT $3`,
      [pattern, q, perType]
    );
    return rows;
  }

  try {
    const [placesResult, routeRows, parksResult] = await Promise.all([
      query(
        // Ищем по имени И по псевдонимам: «Авачинский вулкан» обязан находить
        // «Вулкан Авачинский» — это один вулкан, просто разные источники
        // назвали его по-разному. Слитые записи из выдачи убраны: раньше
        // публичный поиск про merged_into_id не знал вовсе и показывал дубль
        // отдельной строкой.
        `SELECT p.id, p.name AS title, p.location_type, LEFT(p.description, 80) AS subtitle
         FROM places p
         WHERE ${MATCHES_NAME_OR_ALIAS('p', '$1')}
           AND ${NOT_MERGED('p')}
         ORDER BY
           CASE WHEN p.name ILIKE $2 THEN 0 ELSE 1 END,
           LENGTH(p.name) ASC
         LIMIT $3`,
        [pattern, q, perType]
      ),
      findRoutes(),
      // Парки — справочник маленький (единицы строк), ошибка не роняет поиск
      query(
        `SELECT slug, display_name
         FROM parks
         WHERE is_active = true AND display_name ILIKE $1
         ORDER BY display_name
         LIMIT 3`,
        [pattern]
      ).catch(() => ({ rows: [] })),
    ]);

    const lq = q.toLowerCase();
    const matchingTools = STATIC_TOOLS.filter(t =>
      t.title.toLowerCase().includes(lq) || t.subtitle.toLowerCase().includes(lq)
    );
    const matchingPages = STATIC_PAGES.filter(p =>
      p.title.toLowerCase().includes(lq) || p.subtitle.toLowerCase().includes(lq)
    );

    const results = [
      ...routeRows.map(r => ({
        id: `route-${r.id as string}`,
        type: 'route' as const,
        title: r.title as string,
        subtitle: CATEGORY_LABELS[r.category as string] ?? LOCATION_LABELS[r.location_type as string] ?? 'Маршрут',
        href: `/routes/${r.id as string}`,
      })),
      ...placesResult.rows.map(r => ({
        id: `place-${r.id as string}`,
        type: 'place' as const,
        title: r.title as string,
        subtitle: LOCATION_LABELS[r.location_type as string] ?? 'Место',
        href: `/places/${r.id as string}`,
      })),
      ...parksResult.rows.map(r => ({
        id: `park-${r.slug as string}`,
        type: 'park' as const,
        title: r.display_name as string,
        subtitle: 'Природный парк',
        href: `/park/${r.slug as string}`,
      })),
      ...matchingTools.map(t => ({ ...t, type: 'tool' as const })),
      ...matchingPages.map(p => ({ ...p, type: 'page' as const })),
    ];

    const response = NextResponse.json({ success: true, data: results });
    response.headers.set('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    return response;
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка поиска' }, { status: 500 });
  }
}
