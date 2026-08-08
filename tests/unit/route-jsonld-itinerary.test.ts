/**
 * TouristTrip маршрута с itinerary точек (SEO-аудит владельца 08.08:
 * «порядок точек обязателен — без ItemList с position Google и AI плохо
 * понимают маршрут»).
 *
 * Карточка /routes/[id] давно несла богатый TouristTrip (speakable, geo,
 * duration, offers), но БЕЗ главного для маршрута — последовательности мест.
 * Теперь itinerary строится из route_waypoints → places по position, с
 * координатами точек; все script-теги JSON-LD страницы идут через
 * экранирующую обёртку JsonLd (XSS: «<» из строк БД).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(join(process.cwd(), 'app/routes/[id]/page.tsx'), 'utf-8');

describe('itinerary точек маршрута', () => {
  it('точки — из route_waypoints по порядку, через master-таблицы (§4.1)', () => {
    expect(PAGE).toMatch(/FROM route_waypoints rw/);
    expect(PAGE).toMatch(/JOIN kamchatka_routes kr ON kr\.id = rw\.route_id/);
    expect(PAGE).toMatch(/JOIN places p ON p\.id = rw\.place_id/);
    expect(PAGE).toMatch(/ORDER BY rw\.position ASC/);
  });

  it('itinerary — ItemList с position и geo у точек', () => {
    expect(PAGE).toMatch(/itinerary: \{/);
    expect(PAGE).toMatch(/'@type': 'ItemList'/);
    expect(PAGE).toMatch(/'@type': 'TouristAttraction',\s*\n\s*name: w\.name/);
    expect(PAGE).toMatch(/GeoCoordinates', latitude: Number\(w\.lat\)/);
  });

  it('ошибка БД не роняет страницу — разметка без itinerary', () => {
    const fn = /async function getRouteWaypoints[\s\S]*?\n\}/.exec(PAGE)![0];
    expect(fn).toMatch(/catch \{\s*\n\s*return \[\];/);
  });

  it('все JSON-LD страницы — через экранирующую обёртку', () => {
    expect(PAGE).not.toMatch(/dangerouslySetInnerHTML/);
    expect((PAGE.match(/<JsonLd data=/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
