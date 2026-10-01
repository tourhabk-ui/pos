/**
 * Внутренние ссылки — по ЧПУ, а не по UUID (аудит vedarai.ru 01.10).
 *
 * Карточки места и маршрута отвечают на UUID редиректом 308 на ЧПУ. Обход
 * 01.10 нашёл 477 таких адресов во внутренних ссылках: 372 /places/<uuid> и
 * 102 /routes/<uuid>. Больше всего — с карточек мест (блок «Рядом», 2187
 * ссылок) и маршрутов (точки пути, 501), из каталога, категорий и подборок.
 * Каждая такая ссылка — лишний шаг поисковику и второй адрес одной страницы.
 *
 * Каталог читает VIEW, где ЧПУ нет, поэтому адрес собирается одним
 * выражением (lib/routes/url-slug). Поле `slug` у CatalogItem — ключ
 * дедупликации, а не адрес: путать их и было бы новой порчей ссылок.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { arkUrlSlugSql, catalogHref } from '@/lib/routes/url-slug';

const ROOT = process.cwd();
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('catalogHref — раздел по роду, ЧПУ при наличии', () => {
  it('место — /places/<ЧПУ>, маршрут — /routes/<ЧПУ>', () => {
    expect(catalogHref({ id: 'u1', kind: 'place', urlSlug: 'avachinskij' }, '/routes')).toBe('/places/avachinskij');
    expect(catalogHref({ id: 'u2', kind: 'route', urlSlug: 'k-vulkanu' }, '/places')).toBe('/routes/k-vulkanu');
  });

  it('ЧПУ нет — ссылка по id в своём разделе', () => {
    expect(catalogHref({ id: 'u1', kind: 'place', urlSlug: null }, '/routes')).toBe('/places/u1');
  });

  it('род неизвестен — раздел вызывающего и id: ЧПУ места под /routes отвечал бы редиректом', () => {
    expect(catalogHref({ id: 'u3', urlSlug: 'chto-to' }, '/routes')).toBe('/routes/u3');
    expect(catalogHref({ id: 'u4', kind: 'tour', urlSlug: 'x' }, '/routes')).toBe('/routes/u4');
  });

  it('SQL-выражение не принимает псевдоним с подстановкой', () => {
    expect(arkUrlSlugSql('ark')).toMatch(/CASE ark\.kind/);
    expect(() => arkUrlSlugSql('ark; DROP TABLE places')).toThrow();
  });
});

describe('источники ссылок отдают ЧПУ', () => {
  it('каталог: адрес — отдельным полем url_slug, slug остаётся ключом дедупликации', () => {
    const src = code('lib/routes/catalog-query.ts');
    expect(src).toMatch(/\$\{arkUrlSlugSql\('ark'\)\} AS url_slug/);
    expect(src).toMatch(/urlSlug:\s+\(r\.url_slug as string \| null\) \?\? null/);
    expect(src).toMatch(/slug:\s+r\.route_dedupe_key as string/);
  });

  it('карточки каталога ссылаются через catalogHref', () => {
    expect(code('components/routes/PlaceCard.tsx').match(/route\.href \?\? catalogHref\(route, '\/places'\)/g)).toHaveLength(2);
    expect(code('components/routes/RoutePathCard.tsx').match(/route\.href \?\? catalogHref\(route, '\/routes'\)/g)).toHaveLength(2);
    expect(code('components/routes/RouteCard.tsx')).toMatch(/route\.href \?\? catalogHref\(route, '\/routes'\)/);
  });

  it('страница категории даёт карточке готовый адрес по роду и ЧПУ', () => {
    const src = code('components/routes/CategoryPage.tsx');
    expect(src).toMatch(/\$\{arkUrlSlugSql\('agent_route_knowledge'\)\} AS url_slug/);
    expect(src).toMatch(/href: catalogHref\(\{ id: r\.id, kind: r\.kind, urlSlug: r\.url_slug \}, '\/routes'\)/);
  });

  it('«Рядом» на карточке места — по ЧПУ', () => {
    expect(code('lib/places/place-detail.ts')).toMatch(/p\.ark_id AS id,\s*p\.slug,/);
    expect(code('components/places/PlaceNearby.tsx')).toMatch(/href=\{`\/places\/\$\{n\.slug \?\? n\.id\}`\}/);
  });

  it('точки пути и ориентиры маршрута — по ЧПУ', () => {
    expect(code('app/api/routes/[id]/route.ts')).toMatch(/p\.slug AS place_slug/);
    expect(code('app/api/routes/[id]/route.ts')).toMatch(/SELECT p\.id, p\.slug, p\.name/);
    const client = code('app/routes/[id]/_RouteDetailClient.tsx');
    expect(client).not.toMatch(/`\/places\/\$\{w\.placeId\}`/);
    expect(client).not.toMatch(/`\/places\/\$\{wp\.placeId\}`/);
    expect(client).not.toMatch(/`\/places\/\$\{st\.placeId\}`/);
  });

  it('подборка: ЧПУ, маршрут в пространстве id карточки, только видимые места', () => {
    const src = code('lib/collections/resolve.ts');
    expect(src).toMatch(/SELECT p\.id, p\.slug, p\.name/);
    expect(src).toMatch(/AND p\.is_visible = TRUE\s+AND p\.merged_into_id IS NULL/);
    expect(src).toMatch(/SELECT COALESCE\(ark_id, id\) AS id, slug, title/);
    const client = code('app/collections/[slug]/_CollectionDetailClient.tsx');
    expect(client).toMatch(/`\/places\/\$\{place\.slug \?\? place\.id\}`/);
    expect(client).toMatch(/`\/routes\/\$\{route\.slug \?\? route\.id\}`/);
  });
});
