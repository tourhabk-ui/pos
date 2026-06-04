/**
 * GET /api/search
 * Унифицированный поиск: маршруты + места + инструменты.
 * Используется GlobalSearchModal (Ctrl+K).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';

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

  try {
    const [placesResult, routesResult] = await Promise.all([
      query(
        `SELECT id, name AS title, location_type, LEFT(description, 80) AS subtitle
         FROM places
         WHERE name ILIKE $1
         ORDER BY
           CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END,
           LENGTH(name) ASC
         LIMIT $3`,
        [pattern, q, perType]
      ),
      query(
        `SELECT id, title, category, location_type, route_dedupe_key AS slug
         FROM kamchatka_routes
         WHERE is_visible = TRUE AND title ILIKE $1
         ORDER BY
           CASE WHEN title ILIKE $2 THEN 0 ELSE 1 END,
           LENGTH(title) ASC
         LIMIT $3`,
        [pattern, q, perType]
      ),
    ]);

    const lq = q.toLowerCase();
    const matchingTools = STATIC_TOOLS.filter(t =>
      t.title.toLowerCase().includes(lq) || t.subtitle.toLowerCase().includes(lq)
    );
    const matchingPages = STATIC_PAGES.filter(p =>
      p.title.toLowerCase().includes(lq) || p.subtitle.toLowerCase().includes(lq)
    );

    const results = [
      ...routesResult.rows.map(r => ({
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
