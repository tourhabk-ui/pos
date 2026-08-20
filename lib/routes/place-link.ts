/**
 * lib/routes/place-link.ts — правила привязки МЕСТ к МАРШРУТАМ.
 *
 * Механизм привязки уже существовал: миграция 167 связала всё со всем в
 * радиусе 15 км. Отсюда и «паутины» — маршрут, собравший десяток чужих
 * вершин просто потому, что они рядом. Радиус НЕ ЗНАЕТ, проходит ли
 * маршрут через место; он знает только, что они близко.
 *
 * Поэтому здесь нет авто-режима. Модуль умеет две честные вещи:
 *   1. ПОДСКАЗАТЬ кандидатов — по совпадению имени и по расстоянию,
 *      каждый с цифрами, чтобы решение принимал человек;
 *   2. ПРОВЕРИТЬ поимённые пары перед записью.
 *
 * Совпадение имени сильнее близости: «Малкинские горячие источники» и
 * маршрут «Малкинские» — это одно и то же место, даже если координата
 * маршрута стоит у парковки в трёх километрах.
 */

const KM_PER_DEG_LAT = 111.32;

/** Родовые слова: они есть у сотен объектов и не опознают ничего. */
const STOP_WORDS = new Set([
  'вулкан', 'вулкана', 'вулканы', 'сопка', 'сопки', 'гора', 'горы', 'горный',
  'озеро', 'озера', 'озёра', 'река', 'реки', 'бухта', 'бухты', 'мыс',
  'скала', 'скалы', 'водопад', 'водопады', 'долина', 'долины', 'перевал',
  'источник', 'источники', 'источников', 'термальные', 'термальный',
  'горячие', 'горячий', 'музей', 'каньон', 'пещера', 'пещеры', 'кордон',
  'тропа', 'тропы', 'массив', 'хребет', 'плато', 'кратер', 'кальдера',
  'камчатка', 'камчатки', 'камчатке', 'камчатский', 'камчатская',
  'маршрут', 'маршрута', 'поход', 'похода', 'восхождение', 'экскурсия',
  'тур', 'тура', 'день', 'дня', 'дней', 'видовка', 'смотровая', 'площадка',
  'природный', 'парк', 'парка', 'заповедник', 'нарзаны', 'фумарола',
]);

/** Нормализация: регистр, ё, дефисы и пунктуация — прочь. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[^а-я0-9\s-]/g, ' ');
}

/**
 * Значимые слова названия: то, чем объект отличается от соседей.
 * «Малкинские горячие источники» → ['малкинские'].
 */
export function significantTokens(name: string): string[] {
  return normalize(name)
    .split(/[\s-]+/)
    .filter(t => t.length >= 4 && !STOP_WORDS.has(t));
}

/**
 * Грубая основа слова: русские падежи меняют хвост, а не корень.
 * «Малкинские» и «Малкинских» дают общую основу «малкинс».
 */
function stem(token: string): string {
  return token.length > 7 ? token.slice(0, 7) : token;
}

/**
 * Доля значимых слов места, найденных в названии маршрута: 0..1.
 * Ноль — имя ничего не говорит, решать только по расстоянию и глазам.
 */
export function nameMatchScore(placeName: string, routeTitle: string): number {
  const tokens = significantTokens(placeName);
  if (tokens.length === 0) return 0;
  const haystack = normalize(routeTitle);
  const hits = tokens.filter(t => haystack.includes(stem(t))).length;
  return Math.round((hits / tokens.length) * 100) / 100;
}

/** Расстояние по прямой, км (для Камчатки плоской проекции достаточно). */
export function distanceKm(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const midLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  return Math.hypot(
    (aLat - bLat) * KM_PER_DEG_LAT,
    (aLng - bLng) * KM_PER_DEG_LAT * Math.cos(midLat),
  );
}

export interface RouteCandidateInput {
  id: string; title: string;
  lat: number | null; lng: number | null;
  hasGeometry: boolean; waypointCount: number;
}
export interface RouteCandidate {
  routeId: string; title: string;
  nameScore: number; distanceKm: number | null;
  hasGeometry: boolean; waypointCount: number;
}

/**
 * Кандидаты для одного места, отсортированные по убыванию пригодности.
 *
 * Порядок намеренно ставит имя выше близости: маршрут, названный в честь
 * места, — это оно и есть, а ближайшая по координате запись может быть
 * соседней вершиной. Кандидаты без совпадения имени и дальше maxKm не
 * возвращаются вовсе: подсказка обязана быть короткой, иначе её не
 * читают, а листают.
 */
export function suggestRoutes(
  place: { lat: number | null; lng: number | null; name: string },
  routes: RouteCandidateInput[],
  opts: { maxKm?: number; limit?: number } = {},
): RouteCandidate[] {
  const maxKm = opts.maxKm ?? 20;
  const limit = opts.limit ?? 4;

  const scored = routes.map((r) => {
    const nameScore = nameMatchScore(place.name, r.title);
    const d = (place.lat != null && place.lng != null && r.lat != null && r.lng != null)
      ? Math.round(distanceKm(place.lat, place.lng, r.lat, r.lng) * 10) / 10
      : null;
    return {
      routeId: r.id, title: r.title, nameScore, distanceKm: d,
      hasGeometry: r.hasGeometry, waypointCount: r.waypointCount,
    };
  }).filter(c => c.nameScore > 0 || (c.distanceKm != null && c.distanceKm <= maxKm));

  scored.sort((a, b) => {
    if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
    const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
    const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
    return da - db;
  });
  return scored.slice(0, limit);
}

export interface PlaceCandidateInput {
  id: string; name: string; locationType: string | null;
  lat: number | null; lng: number | null;
}
export interface PlaceCandidate {
  placeId: string; name: string; locationType: string | null;
  nameScore: number; distanceKm: number | null;
}

/**
 * Обратная подсказка: кандидаты-МЕСТА для маршрута без путевых точек.
 *
 * Правило то же и в ту же сторону: nameMatchScore спрашивает, называет ли
 * НАЗВАНИЕ МАРШРУТА место, — маршрут «Восхождение на Авачинский вулкан»
 * называет место «Вулкан Авачинский», и это улика происхождения связи
 * (тот же класс, что 238 пар миграций 653-657: совпадение имён). Близость
 * без имени — не улика, поэтому безымянные соседи показываются только в
 * пределах maxKm и с нулевым счётом: их судьбу решает человек.
 */
export function suggestPlaces(
  route: { title: string; lat: number | null; lng: number | null },
  places: PlaceCandidateInput[],
  opts: { maxKm?: number; limit?: number } = {},
): PlaceCandidate[] {
  const maxKm = opts.maxKm ?? 20;
  const limit = opts.limit ?? 4;

  const scored = places.map((p) => {
    const nameScore = nameMatchScore(p.name, route.title);
    const d = (route.lat != null && route.lng != null && p.lat != null && p.lng != null)
      ? Math.round(distanceKm(route.lat, route.lng, p.lat, p.lng) * 10) / 10
      : null;
    return { placeId: p.id, name: p.name, locationType: p.locationType, nameScore, distanceKm: d };
  }).filter(c => c.nameScore > 0 || (c.distanceKm != null && c.distanceKm <= maxKm));

  scored.sort((a, b) => {
    if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
    const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
    const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
    return da - db;
  });
  return scored.slice(0, limit);
}

export interface LinkPair { place: string; route: string }

/**
 * Проверка списка пар до записи: отказ целиком, без частичного применения
 * (правило дедупа мест и маршрутов — то же и здесь).
 */
export function linkPairProblems(pairs: LinkPair[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = `${p.place}→${p.route}`;
    if (seen.has(key)) problems.push(`${key}: пара повторяется в списке`);
    seen.add(key);
  }
  return problems;
}
