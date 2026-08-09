/**
 * Админка маршрутов показывает точки, трек и высоты.
 *
 * Владелец 09.08: «хочу посмотреть в админке маршруты с точками». В списке
 * этого не было вовсе: страница тянет из `agent_route_knowledge` — а это
 * ОБЪЕДИНЕНИЕ мест и маршрутов (§4.1), и различить их было нельзя, не то что
 * увидеть связи `route_waypoints`.
 *
 * Заодно список отвечает на вопрос, который мы весь вечер решали пробами: у
 * скольких маршрутов трек несёт высоты — то есть зажжётся ли профиль в поле.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const API = read('app/api/admin/content/routes/route.ts');
const PAGE = read('app/hub/admin/content/routes/page.tsx');

describe('выборка', () => {
  it('доступ только администратору', () => {
    expect(API).toMatch(/requireAdmin/);
  });

  it('фильтр вида записи — места отдельно, маршруты отдельно', () => {
    expect(API).toMatch(/kind === 'route' \|\| kind === 'place'/);
    expect(PAGE).toMatch(/Только маршруты/);
  });

  it('фильтр «только с точками» сопоставляет id так же, как представление', () => {
    // Идентификатор маршрута в представлении — COALESCE(ark_id, id), а
    // route_waypoints ссылается на kamchatka_routes.id. Сопоставление по
    // «просто id» молча потеряло бы часть маршрутов.
    expect(API).toMatch(/COALESCE\(r\.ark_id, r\.id\) = agent_route_knowledge\.id/);
    expect(API).toMatch(/JOIN route_waypoints rw ON rw\.route_id = r\.id/);
    expect(PAGE).toMatch(/Только с точками/);
  });

  it('счётчики считаются после отбора страницы, а не по всей таблице', () => {
    expect(API).toMatch(/WITH page AS \(/);
    expect(API).toMatch(/FROM page\s+LEFT JOIN LATERAL/);
  });

  it('параметризация сохранена — значения не попадают в текст SQL', () => {
    expect(API).toMatch(/params\.push\(kind\)/);
    // Подстановка внутрь SQL-литерала — вот что запрещено. Сборка самого
    // ЗНАЧЕНИЯ (`%${search}%`) безопасна: оно уезжает отдельным параметром,
    // и путать эти два случая гард не должен.
    expect(API).not.toMatch(/(ILIKE|=)\s*'[^']*\$\{/);
    expect(API).not.toMatch(/kind\s*=\s*'\$\{/);
  });
});

describe('что видно в списке', () => {
  it('число точек маршрута', () => {
    expect(API).toMatch(/FROM route_waypoints rw WHERE rw\.route_id = r\.id/);
    expect(PAGE).toMatch(/Точки/);
    expect(PAGE).toMatch(/r\.waypoints/);
  });

  it('точек в треке и сколько из них с высотой', () => {
    expect(API).toMatch(/jsonb_array_length\(c\) >= 3/);
    expect(PAGE).toMatch(/с высотой/);
    expect(PAGE).toMatch(/без высот/);
  });

  it('место — не маршрут: прочерк вместо нуля', () => {
    // Ноль точек у места означал бы дефект, которого нет: у места точек и не
    // должно быть. Прочерк говорит «неприменимо», ноль сказал бы «пусто».
    expect(PAGE).toMatch(/r\.kind !== 'route' \? \(/);
  });

  it('источник трека виден подсказкой — по нему понятно, откуда высоты', () => {
    expect(API).toMatch(/geometry->>'source'/);
    expect(PAGE).toMatch(/r\.geometrySource/);
  });
});
