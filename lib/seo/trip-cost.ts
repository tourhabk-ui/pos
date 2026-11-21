/**
 * «Сколько стоит поездка на Камчатку» и «Когда ехать на Камчатку» — две
 * страницы, посчитанные из базы (разбор видимости Ведара в ответах ИИ, 19.11:
 * это два самых частых вопроса в «Вопросах по теме» Google, а страницы под
 * них у Ведара не было).
 *
 * Здесь только чистые функции над строками базы. Сумм поездки «за неделю»
 * нет и не будет: состав у каждого свой, а вилка «120–250 тыс.» без источника —
 * ровно та выдумка, которую правило §4.0 запрещает. Есть цены того, что
 * продаётся на Ведаре, — туров по видам, жилья за ночь, машины под заказ — и
 * ссылка на планер, который считает смету из выбранного.
 */
import { canonicalActivity, knownActivityLabel } from '@/lib/tours/labels';
import { plural } from '@/lib/home/data-freshness';
import { priceRangesWords, seasonCover } from '@/lib/seo/query-landing-faq';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

export interface CostTourRow {
  base_price: string;
  price_unit: string | null;
  activity_type: string | null;
  season_start: string | null;
  season_end: string | null;
}

export interface CostStayRow { price_per_night_from: string | null }

export interface KindCost {
  /** Вид словами из словаря каталога; незнакомый вид — «другие туры». */
  label: string;
  count: number;
  /** Вилки цен словами; ни одной цены с понятной единицей — null. */
  prices: string | null;
}

const OTHER = 'Другие туры';

/** Туры по видам: больше туров — выше, при равенстве — по алфавиту. */
export function costByKind(tours: readonly CostTourRow[]): KindCost[] {
  const groups = new Map<string, CostTourRow[]>();
  for (const t of tours) {
    const label = t.activity_type ? knownActivityLabel(canonicalActivity(t.activity_type)) ?? OTHER : OTHER;
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([label, rows]) => ({ label, count: rows.length, prices: priceRangesWords(rows, 'ru')?.text ?? null }))
    .sort((a, b) => (a.label === OTHER ? 1 : 0) - (b.label === OTHER ? 1 : 0) || b.count - a.count || a.label.localeCompare(b.label, 'ru'));
}

function rub(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`;
}

/** Жильё за ночь: «от 3 000 до 18 000 ₽ за ночь (12 объектов)»; цен нет — null. */
export function stayCostWords(stays: readonly CostStayRow[]): string | null {
  const ps = stays.map((s) => Number(s.price_per_night_from)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ps.length) return null;
  const min = Math.min(...ps); const max = Math.max(...ps);
  const span = min === max ? rub(min) : `от ${rub(min)} до ${rub(max)}`;
  return `${span} за ночь (${ps.length} ${plural(ps.length, 'объект', 'объекта', 'объектов')} с ценой «от»)`;
}

/**
 * Машина под заказ по направлениям: «от 3 500 до 60 000 ₽ за машину (24
 * направления у 3 перевозчиков)». Цена — за машину целиком (CLAUDE.md §14),
 * не за место. Цены за час и день сюда не смешиваются.
 */
export function charterCostWords(carriers: readonly Pick<CharterCarrier, 'destinations'>[]): string | null {
  const ps: number[] = [];
  let withPrice = 0;
  for (const c of carriers) {
    const own = c.destinations.map((d) => d.priceRub).filter((n): n is number => typeof n === 'number' && n > 0);
    if (own.length) withPrice += 1;
    ps.push(...own);
  }
  if (!ps.length) return null;
  const min = Math.min(...ps); const max = Math.max(...ps);
  const span = min === max ? rub(min) : `от ${rub(min)} до ${rub(max)}`;
  return `${span} за машину целиком (${ps.length} ${plural(ps.length, 'направление', 'направления', 'направлений')} у ${withPrice} ${plural(withPrice, 'перевозчика', 'перевозчиков', 'перевозчиков')})`;
}

export const RU_MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

export interface MonthTours {
  month: number;
  /** Сколько туров идёт в этом месяце по данным операторов. */
  count: number;
  /** Виды туров месяца словами, больше туров — раньше. */
  kinds: string[];
}

/** Туры по месяцам: месяц входит, если в него попадает сезон тура. */
export function toursByMonth(tours: readonly CostTourRow[]): { months: MonthTours[]; unknown: number } {
  const { unknown } = seasonCover(tours);
  const months: MonthTours[] = [];
  for (let m = 1; m <= 12; m++) {
    const inMonth = tours.filter((t) => seasonCover([t]).months.has(m));
    months.push({ month: m, count: inMonth.length, kinds: costByKind(inMonth).map((k) => k.label) });
  }
  return { months, unknown };
}

export interface TripFaq { q: string; a: string }

/** Вопросы страницы «Сколько стоит»: ответы — те же числа, что на экране. */
export function costFaq(kinds: readonly KindCost[] | null, stay: string | null, charter: string | null): TripFaq[] {
  const out: TripFaq[] = [];
  if (kinds && kinds.length) {
    const priced = kinds.filter((k) => k.prices).slice(0, 4).map((k) => `${k.label.toLowerCase()} — ${k.prices}`);
    if (priced.length) out.push({ q: 'Сколько стоит тур на Камчатку?', a: `По турам, опубликованным на Ведаре: ${priced.join('; ')}. Это цены операторов; итог называет оператор при подтверждении заявки.` });
  }
  if (stay) out.push({ q: 'Сколько стоит жильё на Камчатке?', a: `По объектам на Ведаре — ${stay}. Свободные даты и итог подтверждает хозяин в ответ на заявку.` });
  if (charter) out.push({ q: 'Сколько стоит трансфер или машина под заказ?', a: `По прайсам перевозчиков на Ведаре — ${charter}. Машину заказывают целиком; заявка машину не закрепляет, перевозчик отвечает сам.` });
  out.push({ q: 'Сколько стоит перелёт на Камчатку?', a: 'Цен на билеты у Ведара нет: их называют авиакомпании и сервисы продажи билетов.' });
  out.push({ q: 'Сколько стоит поездка целиком?', a: 'Общей суммы на эту страницу не пишем: она зависит от того, что вы выберете. Планер Ведара складывает смету из выбранных туров и жилья по их ценам.' });
  return out;
}

/** Вопросы страницы «Когда ехать». */
export function whenFaq(months: readonly MonthTours[] | null, fishByMonth: ReadonlyMap<number, string[]>): TripFaq[] {
  const out: TripFaq[] = [];
  if (months && months.some((m) => m.count > 0)) {
    const top = Math.max(...months.map((m) => m.count));
    const best = months.filter((m) => m.count === top).map((m) => RU_MONTHS_NOM[m.month - 1]!.toLowerCase());
    out.push({ q: 'В каком месяце лучше ехать на Камчатку?', a: `Если судить по турам на Ведаре, больше всего их идёт: ${best.join(', ')} (${top} ${plural(top, 'тур', 'тура', 'туров')}). «Лучше» зависит от цели — рыбалка, вулканы, зима; что идёт в каждый месяц, показано по месяцам выше.` });
  }
  const fishMonths = [...fishByMonth.entries()].filter(([, f]) => f.length).map(([m]) => m);
  if (fishMonths.length) {
    out.push({ q: 'Когда на Камчатке рыбалка?', a: `По справочнику рыб Ведара сезоны видов приходятся на месяцы: ${fishMonths.map((m) => RU_MONTHS_NOM[m - 1]!.toLowerCase()).join(', ')}. Какой вид когда — в справочнике рыб Камчатки.` });
  }
  // Туры не прочитались — о зиме молчим: «не опубликовано» было бы неправдой.
  if (months) {
    const winter = [...new Set(months.filter((m) => [12, 1, 2, 3].includes(m.month)).flatMap((m) => m.kinds))];
    out.push({ q: 'Можно ли ехать зимой?', a: winter.length
      ? `Да: зимой (декабрь–март) на Ведаре идут туры — ${winter.map((k) => k.toLowerCase()).join(', ')}.`
      : 'Зимних туров на Ведаре сейчас не опубликовано.' });
  }
  return out;
}

/** Виды рыб по месяцам из справочника (lib/fish-species).
 *  «Лосось» в справочнике — род Oncorhynchus, не отдельный вид; в таблице
 *  «По месяцам» его не ставим рядом с чавычей, кетой и кижучем. */
export function fishByMonth(species: readonly { name: string; seasonMonths: readonly number[] }[]): Map<number, string[]> {
  const kinds = species.filter((s) => s.name !== 'Лосось');
  const map = new Map<number, string[]>();
  for (let m = 1; m <= 12; m++) map.set(m, kinds.filter((s) => s.seasonMonths.includes(m)).map((s) => s.name));
  return map;
}
