/**
 * lib/kuzmich/answer-sources.ts — источники под ответом Кузьмича
 * (#3412, п. 1; слово владельца 15.11 «карт-бланш»).
 *
 * Источник — инструмент этого хода, который принёс данные: что проверено
 * («Погода», «Карточка места»), и, если вывод инструмента дал страницу
 * Ведара, ссылка на неё с именем из той же строки. Строит код из настоящего
 * вывода, модель здесь ничего не пишет: сносок, которых нет среди
 * результатов, не бывает по построению. Номеров внутри текста ответа нет —
 * привязать утверждение к источнику смогла бы только модель, а это и была бы
 * выдуманная сноска.
 *
 * Модуль едет в браузер (кнопки под ответом): без lookbehind и без серверных
 * импортов.
 */

export interface AnswerSource {
  /** Что проверено, словами; с именем страницы, если оно есть. */
  title: string;
  /** Путь страницы Ведара (без запроса и якоря) или null — данные без своей страницы. */
  href: string | null;
}

const SOURCE_WORDS: Record<string, string> = {
  get_guardian_context: 'Обстановка и безопасность места',
  safety_status: 'Обстановка в крае',
  get_volcano_status: 'Состояние вулканов',
  get_weather: 'Погода',
  get_place_info: 'Карточка места',
  get_tours: 'Каталог туров',
  get_tour_details: 'Описание тура',
  get_tour_availability: 'Свободные места',
  compare_tours: 'Сравнение туров',
  search_accommodations: 'Жильё',
  search_transfers: 'Трансферы',
  search_car_rental: 'Прокат машин',
  search_gear: 'Снаряжение',
  search_kamchatka: 'Данные Ведара',
  make_trip_plan: 'План поездки',
  edit_trip_plan: 'План поездки',
  get_flight_board: 'Табло аэропорта',
};

/** Инструменты, у которых источник назван; прочие под ответом не показываются. */
export const SOURCE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(SOURCE_WORDS));

/** Какая страница — главная для инструмента. Других ссылок вывода источник не берёт. */
const PRIMARY_PAGE: Record<string, RegExp> = {
  get_guardian_context: /^\/places\/[^/]+$/,
  get_place_info: /^\/places\/[^/]+$/,
  get_tour_details: /^\/catalog\/tours\/[^/]+$/,
  get_tour_availability: /^\/catalog\/tours\/[^/]+$/,
  make_trip_plan: /^\/trip\/[^/]+$/,
  edit_trip_plan: /^\/trip\/[^/]+$/,
  search_accommodations: /^\/accommodations\/[^/]+$/,
  search_transfers: /^\/transfers\/[^/]+$/,
  search_car_rental: /^\/car-rental\/[^/]+$/,
};

const VEDAR_URL = /https?:\/\/(?:www\.)?vedarai\.ru(\/[^\s,;)»"<>]*)/g;

/** Первая главная страница в выводе и имя «…» из той же строки. */
function primaryPage(tool: string, output: string): { href: string; name: string | null } | null {
  const kind = PRIMARY_PAGE[tool];
  if (!kind) return null;
  for (const line of output.split('\n')) {
    for (const m of line.matchAll(VEDAR_URL)) {
      const path = m[1].replace(/[.,!?:]+$/, '').split(/[?#]/)[0];
      if (!kind.test(path)) continue;
      const before = line.slice(0, m.index);
      const quoted = before.match(/«([^»]{1,80})»(?!.*«)/);
      return { href: path, name: quoted ? quoted[1] : null };
    }
  }
  return null;
}

/** Источник одного вызова инструмента, принёсшего данные; null — показывать нечего. */
export function toolSource(tool: string, output: string): AnswerSource | null {
  const words = SOURCE_WORDS[tool];
  if (!words) return null;
  const page = primaryPage(tool, output);
  if (!page) return { title: words, href: null };
  return { title: page.name ? `${words}: ${page.name}` : words, href: page.href };
}

/** Источники хода по порядку вызовов, без повторов, не больше `max`. */
export function answerSources(sources: ReadonlyArray<AnswerSource | null | undefined>, max = 6): AnswerSource[] {
  const out: AnswerSource[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    const key = `${s.title}|${s.href ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
