/**
 * Перевозчики «под заказ»: типы и чистое форматирование прайса (миграция 1185).
 *
 * Отдельно от charter.ts намеренно: тот читает базу (pg), а карточку рисует и
 * клиентский экран /transfers — импорт загрузчика потащил бы драйвер БД в
 * браузерный бандл. Здесь ни сети, ни базы.
 */

export type CharterVehicleKind = 'jeep' | 'vahtovka' | 'minibus' | 'other';

export interface CharterVehicle {
  kind: CharterVehicleKind;
  title: string;
  seats: number;
}

export interface CharterPriceLine {
  from: string;
  to: string;
  priceRub: number;
  /** «плюс переправы»; null — примечания нет. */
  note: string | null;
  /** «при расчёте наличными»; null — условие не записано. */
  conditions: string | null;
  /** null — год прайса не записан. */
  validYear: number | null;
}

export interface CharterExtraDay {
  priceRub: number;
  note: string | null;
  conditions: string | null;
  validYear: number | null;
}

/** Снимок с подписью: credit — автор, если он назван; null — подписывается самим перевозчиком. */
export interface CharterPhoto {
  url: string;
  credit: string | null;
}

/** Короткая петля «красота и движ»: файл, кадр-обложка и что на ней словами. */
export interface CharterClip {
  url: string;
  poster: string;
  label: string;
}

/** С кем договор: название исполнителя и, если назван, ИНН. */
export interface CharterLegal {
  name: string;
  /** 10 или 12 цифр; null — не записан или записан не по форме. */
  inn: string | null;
}

/** Ролик перевозчика: адрес и кадр-обложка вместе (миграция 1185) или ничего. */
export interface CharterVideo {
  url: string;
  poster: string;
}

export interface CharterCarrier {
  partnerId: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  vehicles: CharterVehicle[];
  destinations: CharterPriceLine[];
  /** Доплата за день работы машины на месте; null — не назначена. */
  extraDay: CharterExtraDay | null;
  /** Герой первым, затем галерея; без повторов. */
  photos: CharterPhoto[];
  /** Короткие петли для ленивого показа; [] — клипов нет. */
  clips: CharterClip[];
  /** Исполнитель по договору; null — реквизиты не записаны. */
  legal: CharterLegal | null;
  /** null — ролика нет (или он записан без обложки: такой не показывается). */
  video: CharterVideo | null;
  /** «+7XXXXXXXXXX»; null — не записан. В ответ AI-инструментов не уходит. */
  phone: string | null;
  telegramHref: string | null;
  whatsappHref: string | null;
}

/**
 * Что экран знает о перевозчиках под заказ: три исхода, не два. Пустой список
 * при `ok` — «искали, никого нет»; `failed` — «не смогли проверить», и экран
 * обязан сказать это вслух, а не промолчать.
 */
export type CharterState = { state: 'ok'; carriers: CharterCarrier[] } | { state: 'failed' };

const KIND_FORM: Record<CharterVehicleKind, string> = {
  jeep: 'джип',
  vahtovka: 'вахтовка',
  minibus: 'микроавтобус',
  other: 'транспорт',
};

/** «2 × вахтовка, 26 мест»: парк одной строкой; пусто, если машин не записано. */
export function describeFleet(vehicles: CharterVehicle[]): string | null {
  if (vehicles.length === 0) return null;
  const groups = new Map<string, { kind: CharterVehicleKind; seats: number; n: number }>();
  for (const v of vehicles) {
    const key = `${v.kind}/${v.seats}`;
    const g = groups.get(key);
    if (g) g.n += 1;
    else groups.set(key, { kind: v.kind, seats: v.seats, n: 1 });
  }
  return [...groups.values()]
    .map((g) => `${g.n} × ${KIND_FORM[g.kind]}, ${g.seats} мест`)
    .join('; ');
}

export function formatRub(n: number): string {
  // Пробел-разделитель тысяч одинаков на сервере и в браузере (toLocaleString
  // зависит от ICU среды и расходится при гидратации).
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
}

/**
 * Общая сноска прайса: условия и год, одинаковые у всех строк, называются один
 * раз; различающиеся — перечисляются, а не склеиваются в одно «для всех».
 */
export function charterFootnote(c: Pick<CharterCarrier, 'destinations' | 'extraDay'>): string | null {
  const lines = [...c.destinations, ...(c.extraDay ? [c.extraDay] : [])];
  if (lines.length === 0) return null;
  const years = [...new Set(lines.map((l) => l.validYear).filter((y): y is number => y !== null))];
  const conds = [...new Set(lines.map((l) => l.conditions).filter((x): x is string => !!x))];
  const froms = [...new Set(c.destinations.map((d) => d.from))];
  const parts: string[] = [];
  if (years.length > 0) parts.push(`прайс ${years.join(' и ')} года`);
  if (froms.length > 0) parts.push(`отправление — ${froms.join(', ')}`);
  if (conds.length > 0) parts.push(conds.join('; '));
  if (parts.length === 0) return null;
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

// ── Сопоставление направления с прайсом ─────────────────────────────────────

/** Нижний регистр, «ё» = «е», пробелы схлопнуты: так «Мёртвый лес» и «мертвый  лес» равны. */
function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * Значимые слова запроса, сведённые к началу слова. Слово короче четырёх букв
 * («на», «к», «в») ничего не различает и отбрасывается; из остальных срезаются
 * последние три буквы, но не глубже четырёх: «Авачинскую» находит «Авачинский»,
 * «Толбачика» — «Толбачик». Это не морфология, а грубый общий корень: ошибка в
 * сторону «не нашли» безопасна (направление считается заказным, цену называет
 * перевозчик), ошибка в сторону «нашли чужое» — нет, поэтому слова должны
 * совпасть ВСЕ, а не любое.
 */
function stems(needle: string): string[] {
  return norm(needle)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, Math.max(4, w.length - 3)));
}

/**
 * Строки прайса, подходящие под слова запроса. Одна мера для поиска
 * (search_transfers) и для заявки (request_charter): если бы они считали по-
 * разному, поиск говорил бы «такого направления нет», а заявка ставила бы на
 * него цену.
 *
 * `includeFrom` — искать и по пункту отправления: поиск спрашивает «куда или
 * откуда», заявка — только «куда». Точное совпадение названия направления
 * побеждает остальные («Горелый» не должен стать неоднозначным из-за
 * «Вулкан Горелый» и «Горелый — Мутновский», если такой появится).
 */
export function matchDestinations<T extends { from: string; to: string }>(
  lines: T[],
  needle: string,
  opts: { includeFrom?: boolean } = {},
): T[] {
  const want = stems(needle);
  if (want.length === 0) return [];
  const exact = lines.filter((l) => norm(l.to) === norm(needle));
  if (exact.length > 0) return exact;
  return lines.filter((l) => {
    const hay = norm(opts.includeFrom ? `${l.to} ${l.from}` : l.to);
    return want.every((w) => hay.includes(w));
  });
}

/** Вместимость парка: сколько мест в самой большой машине и во всех вместе; null — машин не записано. */
export function fleetCapacity(vehicles: CharterVehicle[]): { total: number; largest: number; count: number } | null {
  if (vehicles.length === 0) return null;
  return {
    total: vehicles.reduce((n, v) => n + v.seats, 0),
    largest: Math.max(...vehicles.map((v) => v.seats)),
    count: vehicles.length,
  };
}

/**
 * Сколько машин нужно ПО ЧИСЛУ МЕСТ: берём самые вместительные, пока не хватит.
 * null — парк не записан или людей больше, чем мест во всех машинах. Это арифметика
 * по вместимости, а не обещание: свободны ли машины в эти дни, система не знает.
 */
export function vehiclesNeeded(vehicles: CharterVehicle[], passengers: number): number | null {
  const seats = vehicles.map((v) => v.seats).sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < seats.length; i++) {
    sum += seats[i]!;
    if (sum >= passengers) return i + 1;
  }
  return null;
}
