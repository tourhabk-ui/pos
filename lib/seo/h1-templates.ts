/**
 * Шаблоны H1 (спецификация Сыщика 21.11, «дубли H1 и тонкие страницы»).
 *
 * Один объект живёт в нескольких шаблонах — место, маршрут, тур, летопись,
 * парк, — и у всех H1 был голым именем: 142 группы одинаковых заголовков.
 * Главная сущность группы (место) сохраняет короткое имя, остальные шаблоны
 * получают типизированный H1. В заголовок идут только поля записи; нет поля —
 * нет хвоста, ничего не сочиняется.
 */

import { priceUnitKnown, priceWithUnitWords } from '@/lib/tours/price-label';

const DIFFICULTY_RU: Record<string, string> = {
  easy: 'лёгкая', medium: 'средняя', hard: 'сложная', extreme: 'экстремальная',
};

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
}

export interface RouteHeadingFacts {
  title: string;
  distanceKm: number | null;
  elevationGainM: number | null;
  durationHours: number | null;
  durationDays: number | null;
  difficulty: string | null;
}

/** Имя уже говорит о пути: «Восхождение…», «Сплав…», «Эко-тропа…», «Маршрут…». */
const PATH_NAME = /^(восхождение|сплав|эко-?тропа|экологическая тропа|маршрут|тропа|поход|траверс|трекинг|радиальн)/i;

/** Факты маршрута через запятую: км, набор, время, сложность — что записано. */
export function routeHeadingFacts(f: Omit<RouteHeadingFacts, 'title'>): string[] {
  const parts: string[] = [];
  if (f.distanceKm != null && f.distanceKm > 0) parts.push(`${fmtNum(f.distanceKm)} км`);
  if (f.elevationGainM != null && f.elevationGainM > 0) parts.push(`набор ${Math.round(f.elevationGainM)} м`);
  if (f.durationDays != null && f.durationDays > 1) parts.push(`${f.durationDays} дн.`);
  else if (f.durationHours != null && f.durationHours > 0) parts.push(`${fmtNum(f.durationHours)} ч`);
  const d = (f.difficulty ?? '').trim();
  if (d) parts.push(`сложность ${DIFFICULTY_RU[d.toLowerCase()] ?? d.toLowerCase()}`);
  return parts;
}

/**
 * T2. H1 карточки маршрута.
 *  - обычное имя: `Маршрут «{name}», {km} км` (км — если записан);
 *  - имя уже про путь: `{name}: {км, набор, время, сложность — что есть}`.
 */
export function routeHeading(f: RouteHeadingFacts): string {
  const name = f.title.trim();
  if (PATH_NAME.test(name)) {
    const facts = routeHeadingFacts(f);
    return facts.length > 0 ? `${name}: ${facts.join(', ')}` : name;
  }
  const km = f.distanceKm != null && f.distanceKm > 0 ? `, ${fmtNum(f.distanceKm)} км` : '';
  // Имя с кавычками внутри не берём в ещё одни «ёлочки».
  return name.includes('«') ? `Маршрут: ${name}${km}` : `Маршрут «${name}»${km}`;
}

/** T2. Хвост title маршрута с фактами: `: маршрут 14 км, набор 1859 м…`; фактов нет — null. */
export function routeTitleFactsTail(f: Omit<RouteHeadingFacts, 'title'>): string | null {
  const facts = routeHeadingFacts(f);
  return facts.length > 0 ? `: маршрут ${facts.join(', ')}` : null;
}

/** T3. Хвост H1 тура — оператор из записи (`partners.name`); пусто — без хвоста. */
export function tourHeadingTail(operatorName: string | null | undefined): string | null {
  const op = (operatorName ?? '').trim();
  return op ? `тур «${op}»` : null;
}

/** T4. Летопись объекта, у которого есть страница парка: `{title}: история и летопись`. */
export function chronicleHeading(title: string, parkSlugs: readonly string[] | undefined): string {
  return parkSlugs && parkSlugs.length > 0 ? `${title}: история и летопись` : title;
}

/** T4. Парк, у которого есть статья летописи: `{name}: маршруты, карты и разрешения`. */
export function parkHeading(name: string, hasChronicle: boolean): string {
  return hasChronicle ? `${name}: маршруты, карты и разрешения` : name;
}

/** T4. Место — главный объект статьи летописи об ООПТ: `{name}: как добраться и посетить`. */
export function placeHeading(name: string, ooptMain: boolean): string {
  return ooptMain ? `${name}: как добраться и посетить` : name;
}

/** T5. Подборка: `{title} — подборка мест` / `маршрутов` / `мест и маршрутов` — по составу. */
export function collectionHeading(title: string, kinds: { places: number; routes: number }): string {
  if (/подборк/i.test(title)) return title;
  if (kinds.places > 0 && kinds.routes > 0) return `${title} — подборка мест и маршрутов`;
  if (kinds.routes > 0) return `${title} — подборка маршрутов`;
  if (kinds.places > 0) return `${title} — подборка мест`;
  return title;
}

/** T7. Прокатчик и перевозчик с одним именем: тип услуги в H1. */
export const RENTAL_HEADING_TAIL = ' — аренда автомобилей';
export const CARRIER_HEADING_TAIL = ' — трансфер и машина с водителем';

/**
 * Тонкие смотровые (раздел 2 спецификации). Каноникал — на родителя, который
 * есть в sitemap и однозначно назван в имени смотровой; без такого родителя —
 * noindex (родителя не выдумываем). Карточка на карте остаётся.
 */
export const PLACE_CANONICAL_PARENT: Readonly<Record<string, string>> = {
  'vid-na-dolinu-u-klyuchevskih-vulkanov': 'vulkan-klyuchevskaya-sopka',
  'vid-na-ganalskie-vostryaki': 'ganalskie-vostryaki',
  'vid-na-dolinu-golubyh-ozyor': 'golubye-ozyora',
};
export const PLACE_NOINDEX: ReadonlySet<string> = new Set([
  'vid-na-sopku-ostraya',
  'vid-na-vulkan-shmidta-s-gamchenskogo-dola',
]);

/**
 * Маршруты, чьё описание не подтверждается источниками, — noindex и вне
 * sitemap, пока запись не перепишут по фактам (Сыщик, 21.11).
 * visitkamchatka-krasnaya-sopka: «вулкан 1234 м из группы домашних, подъём
 * 3–4 часа», охраняемая территория — Кроноцкий заповедник. В каталоге активных
 * вулканов KVERT такого нет, домашние вулканы — Корякский, Авачинский,
 * Козельский; «Красная сопка» в городе — горнолыжная база на сопке Петровская
 * с верхней точкой 418 м (СШОР «Эдельвейс», visitkamchatka), а перевал
 * Красная сопка — в Авачинской группе. Какая из них имелась в виду, по записи
 * не понять: переписывать не на чем.
 */
export const ROUTE_NOINDEX: ReadonlySet<string> = new Set([
  'visitkamchatka-krasnaya-sopka',
]);

export function routeInSitemap(slug: string | null): boolean {
  return !slug || !ROUTE_NOINDEX.has(slug);
}

/** В sitemap — только индексируемые адреса со своим каноникалом. */
export function placeInSitemap(slug: string | null): boolean {
  if (!slug) return true;
  return !(slug in PLACE_CANONICAL_PARENT) && !PLACE_NOINDEX.has(slug);
}

/**
 * T3. Хвосты title тура: `: тур {срок}, {цена с единицей}, {оператор}` —
 * только заполненные поля, от полного к короткому; дальше — прежние хвосты.
 *
 * Цена — та же строка, что на карточке (`priceWithUnitWords`): «11 000 ₽ за
 * человека», без «от». У тура одна цена, и «от» дописывал шаблон, а не
 * оператор (сверка 21.11 в #3487: «Первый рассвет» — «от 11 000 ₽» в title
 * при «11 000 ₽ за человека» на карточке). Единица не записана — цены в
 * заголовке нет: голая сумма читается как цена с человека.
 */
export function tourTitleTails(f: {
  duration: string | null;
  basePrice: string | number | null;
  priceUnit: string | null;
  operatorName: string | null;
}): string[] {
  const price = priceUnitKnown(f.priceUnit) ? priceWithUnitWords(f.basePrice, f.priceUnit) : null;
  const op = (f.operatorName ?? '').trim() || null;
  const dur = (f.duration ?? '').trim() || null;
  const variants = [
    [dur, price, op],
    [dur, price],
    [price, op],
    [dur, op],
    [op],
  ].map((v) => v.filter((x): x is string => Boolean(x)))
    .filter((v) => v.length > 0)
    .map((v) => `: тур ${v.join(', ')}`);
  return [...new Set(variants)];
}
