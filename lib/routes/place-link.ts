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
 *
 * НО У ИМЕНИ ЕСТЬ ПОТОЛОК (23.08). Правило «имя сильнее близости» стояло
 * без ограничения расстояния, и сухой прогон на 140 местах показал, во что
 * это обходится: «Большие Тюшевские источники» сватались одноимённому
 * маршруту за 329 км, «Дранкинские» — за 220, а «Корякский природный
 * заповедник» (север края) — «Вулкану Корякскому» у Петропавловска, за
 * 851 км, с идеальным совпадением имени. Совпало слово, а не предмет.
 *
 * Оправданием потолка была парковка в трёх километрах — три, не восемьсот.
 * Поэтому пара с совпавшим именем и расстоянием больше NAME_MATCH_MAX_KM
 * перестаёт быть кандидатом на связь и становится УЛИКОЙ: одна из двух
 * координат врёт. Выбрасывать её нельзя — это находка, а не шум.
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

/**
 * Потолок для пары, совпавшей ИМЕНЕМ.
 *
 * Координата маршрута — часто НЕ объект, а начало пути: стоянка, посёлок,
 * иногда сам Петропавловск. До Авачинского от города двадцать пять
 * километров, до Мутновского — семьдесят, и такая пара честна.
 *
 * Сначала здесь стояло 25 — и сторож `place-link` тут же покраснел на
 * маршруте «Восхождение на Авачинский вулкан» с городским стартом: 25.4 км
 * до собственной цели. Порог, отсекающий настоящую связь, хуже отсутствия
 * порога, поэтому цифра выбрана по данным, а не по интуиции.
 *
 * Замер 23.08 на 140 местах: честные пары лежали в 0.6-25.4 км, ложные
 * начинались со 133 (дальше 220, 243, 329, 443, 851). Между тридцатью и
 * ста тридцатью — пустота; 80 стоит в её середине и с запасом накрывает
 * дневной выезд по камчатским расстояниям.
 */
export const NAME_MATCH_MAX_KM = 80;

/**
 * Род пары «место — маршрут»: связь, улика или незнание.
 *
 *   link     — можно связывать: имя и расстояние сходятся;
 *   conflict — имя совпало, объекты далеко: одна из координат врёт;
 *   unknown  — расстояние не посчитать (нет координаты у кого-то из двух).
 *
 * Третий исход НЕ равен второму и не равен первому: незнание решает
 * человек, и молча превращать его в «связь» или в «улику» нельзя (§4.0).
 */
export type PairKind = 'link' | 'conflict' | 'unknown';

export function classifyPair(
  nameScore: number,
  distanceKm: number | null,
  maxKm: number = NAME_MATCH_MAX_KM,
): PairKind {
  if (distanceKm === null) return 'unknown';
  if (distanceKm <= maxKm) return 'link';
  // Далеко. Совпавшее имя тут не оправдание, а как раз причина насторожиться:
  // два одноимённых объекта в сотнях километров — это ошибка в данных.
  return nameScore > 0 ? 'conflict' : 'link';
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
  opts: { maxKm?: number; limit?: number; farKm?: number } = {},
): RouteCandidate[] {
  const maxKm = opts.maxKm ?? 20;
  const farKm = opts.farKm ?? NAME_MATCH_MAX_KM;
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
  }).filter(c => c.nameScore > 0 || (c.distanceKm != null && c.distanceKm <= maxKm))
    // Пары-улики в кандидаты не идут: предложить связь на 851 км значит
    // предложить нарисовать на карточке заповедника маршрут на чужой вулкан.
    // Собирает их отдельно conflictingPairs — терять их нельзя.
    .filter(c => classifyPair(c.nameScore, c.distanceKm, farKm) !== 'conflict');

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
  opts: { maxKm?: number; limit?: number; farKm?: number } = {},
): PlaceCandidate[] {
  const maxKm = opts.maxKm ?? 20;
  const farKm = opts.farKm ?? NAME_MATCH_MAX_KM;
  const limit = opts.limit ?? 4;

  const scored = places.map((p) => {
    const nameScore = nameMatchScore(p.name, route.title);
    const d = (route.lat != null && route.lng != null && p.lat != null && p.lng != null)
      ? Math.round(distanceKm(route.lat, route.lng, p.lat, p.lng) * 10) / 10
      : null;
    return { placeId: p.id, name: p.name, locationType: p.locationType, nameScore, distanceKm: d };
  }).filter(c => c.nameScore > 0 || (c.distanceKm != null && c.distanceKm <= maxKm))
    // Пары-улики в кандидаты не идут: предложить связь на 851 км значит
    // предложить нарисовать на карточке заповедника маршрут на чужой вулкан.
    // Собирает их отдельно conflictingPairs — терять их нельзя.
    .filter(c => classifyPair(c.nameScore, c.distanceKm, farKm) !== 'conflict');

  scored.sort((a, b) => {
    if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
    const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
    const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
    return da - db;
  });
  return scored.slice(0, limit);
}

/**
 * Пара, у которой имя совпало, а объекты далеко: одна координата врёт.
 *
 * Координаты ОБЕИХ сторон входят в улику намеренно. Проба 157 показала
 * улику без них: «Большие Тюшевские источники — одноимённый маршрут —
 * 329 км». Работать с этим нельзя: сказано, что кто-то врёт, но не
 * сказано, где каждый из двух себя считает, — а чинить надо ровно одну
 * запись из двух. Улика, по которой нельзя сделать следующий шаг, — это
 * не находка, а тревога без адреса.
 */
export interface CoordinateConflict {
  placeId: string; placeName: string;
  placeLat: number; placeLng: number;
  routeId: string; routeTitle: string;
  routeLat: number; routeLng: number;
  nameScore: number; distanceKm: number;
}

/**
 * Согласны ли одноимённые маршруты между собой.
 *
 *   routes_agree    — их несколько и стоят кучно: в стороне одно место,
 *                     и подозрение падает на его координату;
 *   routes_disagree — их несколько и они сами разбросаны: общей правды
 *                     нет, разбирать поимённо;
 *   single_witness  — свидетель один, и который из двух врёт — не
 *                     определить. Это третий исход, и он не равен
 *                     первому: одиночное расхождение бывает и оттого,
 *                     что объекты просто разные.
 */
export type ConflictAgreement = 'routes_agree' | 'routes_disagree' | 'single_witness';

/** Разброс, в пределах которого одноимённые маршруты считаются кучными. */
export const CONFLICT_AGREEMENT_KM = 25;

export interface ConflictCluster {
  placeId: string; placeName: string;
  placeLat: number; placeLng: number;
  agreement: ConflictAgreement;
  /** Наибольшее расстояние между самими маршрутами; null — маршрут один. */
  routesSpreadKm: number | null;
  routes: Array<{
    routeId: string; routeTitle: string;
    lat: number; lng: number;
    nameScore: number; distanceKm: number;
  }>;
}

/**
 * Улики, сгруппированные по месту, с ответом на вопрос «кто в одиночестве».
 *
 * Вердикта «врёт место» здесь нет намеренно: кучность маршрутов — сильный
 * довод, но довод, а не доказательство. Функция сообщает ФАКТ (сошлись
 * свидетели или нет) и обе координаты; вывод делает человек, у которого
 * есть внешний справочник.
 */
export function clusterConflicts(conflicts: CoordinateConflict[]): ConflictCluster[] {
  const byPlace = new Map<string, CoordinateConflict[]>();
  for (const c of conflicts) {
    const bucket = byPlace.get(c.placeId);
    if (bucket) bucket.push(c); else byPlace.set(c.placeId, [c]);
  }

  const out: ConflictCluster[] = [];
  for (const group of byPlace.values()) {
    const first = group[0];
    let spread: number | null = null;
    if (group.length > 1) {
      spread = 0;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const d = distanceKm(group[i].routeLat, group[i].routeLng, group[j].routeLat, group[j].routeLng);
          if (d > spread) spread = d;
        }
      }
      spread = Math.round(spread * 10) / 10;
    }

    const agreement: ConflictAgreement = spread === null
      ? 'single_witness'
      : (spread <= CONFLICT_AGREEMENT_KM ? 'routes_agree' : 'routes_disagree');

    out.push({
      placeId: first.placeId, placeName: first.placeName,
      placeLat: first.placeLat, placeLng: first.placeLng,
      agreement,
      routesSpreadKm: spread,
      routes: group
        .map(c => ({
          routeId: c.routeId, routeTitle: c.routeTitle,
          lat: c.routeLat, lng: c.routeLng,
          nameScore: c.nameScore, distanceKm: c.distanceKm,
        }))
        .sort((a, b) => b.nameScore - a.nameScore),
    });
  }

  // Кучные — первыми: по ним следующий шаг очевиден.
  const rank: Record<ConflictAgreement, number> = {
    routes_agree: 0, routes_disagree: 1, single_witness: 2,
  };
  return out.sort((a, b) => (rank[a.agreement] - rank[b.agreement])
    || (b.routes.length - a.routes.length));
}

/**
 * Улики по одному месту: одноимённые маршруты дальше потолка.
 *
 * Отдельная функция, а не побочный результат подсказчика, ровно по правилу
 * «отсев виден»: связь и улика — разные исходы, и второй не должен
 * растворяться в первом. По этим парам чинят не связи, а координаты.
 */
export function conflictingPairs(
  place: { id: string; name: string; lat: number | null; lng: number | null },
  routes: RouteCandidateInput[],
  farKm: number = NAME_MATCH_MAX_KM,
): CoordinateConflict[] {
  if (place.lat === null || place.lng === null) return [];
  const out: CoordinateConflict[] = [];
  for (const r of routes) {
    if (r.lat === null || r.lng === null) continue;
    const nameScore = nameMatchScore(place.name, r.title);
    if (nameScore <= 0) continue;
    const d = Math.round(distanceKm(place.lat, place.lng, r.lat, r.lng) * 10) / 10;
    if (classifyPair(nameScore, d, farKm) !== 'conflict') continue;
    out.push({
      placeId: place.id, placeName: place.name,
      placeLat: place.lat, placeLng: place.lng,
      routeId: r.id, routeTitle: r.title,
      routeLat: r.lat, routeLng: r.lng,
      nameScore, distanceKm: d,
    });
  }
  // Дальние — первыми: чем больше расхождение, тем очевиднее ошибка.
  return out.sort((a, b) => b.distanceKm - a.distanceKm);
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
