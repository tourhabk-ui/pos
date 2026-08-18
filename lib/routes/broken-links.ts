/**
 * lib/routes/broken-links.ts — связи маршрута с точкой, опровергнутые треком.
 *
 * ── Что здесь считается битым ─────────────────────────────────────────────
 *
 * НЕ линия. Перепись 18.08: 277 линий из 301 — доказанные записи прибора
 * (высота на каждой точке, неровный шаг, плотность, непрерывность). Выбросить
 * их значило бы выбросить единственное, что у платформы есть настоящего.
 *
 * НЕ место. `places` — географический факт: вулкан стоит там, где стоит, и к
 * ошибке привязки отношения не имеет.
 *
 * Битой считается СВЯЗЬ `route_waypoints`: запись утверждает «маршрут проходит
 * через эту точку», а собственный трек маршрута там не проходит. Это ложь,
 * опровергнутая данными самого маршрута, и она попадает человеку в поле:
 * полевой скрин 17.08 показывал «до следующей точки 14 км», стоя на тропе.
 *
 * ── Почему только у доказанных линий ──────────────────────────────────────
 *
 * Расхождение точки и линии само по себе не говорит, кто из них врёт. Если
 * линия — скрейп неизвестного происхождения, виноватой может быть она, и
 * удаление точки закрепило бы ошибку.
 *
 * Улика меняет расклад: у линии, доказанной как запись прибора, есть
 * свидетельство, а у привязки — нет. Тогда и только тогда лишней объявляется
 * привязка.
 *
 * ── Чего это НЕ даст ──────────────────────────────────────────────────────
 *
 * Ни одного пригодного маршрута. Убрав единственную точку, маршрут получает
 * ноль точек и по-прежнему не проходит черту («сверить не с чем»). Уборка
 * убирает ЛОЖЬ, а не добавляет годности — путать эти два результата нельзя.
 */

import { projectOnTrack, DATA_CONFLICT_KM, type GeoPoint } from '@/lib/on-route/approach';
import { normalizeTitle } from '@/lib/routes/title-dupes';

/**
 * Точка-ТЁЗКА: её имя есть в имени маршрута.
 *
 * Сухой прогон 18.08 показал две такие строки:
 *
 *   Восхождение на Вилючинский вулкан → Вулкан Вилючинский: 7.9 км
 *   Озеро Толмачева → Толмачёва: 6 км
 *
 * Здесь расхождение читается наоборот. Если трек «Восхождения на Вилючинский»
 * не подходит к Вилючинскому ближе восьми километров, врёт скорее ЛИНИЯ: к
 * записи прицепили чужой трек. Снять точку значило бы стереть единственное
 * верное сведение и оставить неверное — а маршрут после этого выглядел бы
 * согласованным, что хуже явного противоречия.
 *
 * Улика записи тут не спасает: она доказывает, что линию сняли прибором, но
 * НЕ доказывает, что сняли именно этот маршрут. Имя — независимый источник, и
 * при споре с геометрией оно старше: имя дал человек, привязку — импорт.
 */
/**
 * Родовые слова: они есть у половины записей и тёзкой никого не делают.
 *
 * «Долина гейзеров» и «Долина смерти» — разные места, общее слово «долина»
 * их не роднит. Совпадать должно ИМЯ СОБСТВЕННОЕ.
 */
const GENERIC_WORDS = new Set([
  'вулкан', 'сопка', 'гора', 'озеро', 'река', 'ручей', 'бухта', 'мыс',
  'перевал', 'долина', 'парк', 'природный', 'источник', 'источники',
  'горячие', 'восхождение', 'поход', 'тропа', 'маршрут', 'смотровая',
]);

/** Значащие слова имени: без родовых и без коротких. */
function significantWords(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeTitle(title).split(/[^а-яa-z0-9]+/)) {
    if (w.length < 5) continue;
    if (GENERIC_WORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

export function isNamesakeOfRoute(routeTitle: string, placeTitle: string): boolean {
  const route = significantWords(routeTitle);
  const place = significantWords(placeTitle);
  if (route.size === 0 || place.size === 0) return false;
  for (const w of place) {
    if (route.has(w)) return true;
  }
  return false;
}

export interface LinkCandidate {
  routeId: string;
  routeTitle: string;
  placeId: string;
  placeTitle: string;
  /** Насколько точка отстоит от собственной линии маршрута, км. */
  offTrackKm: number;
}

/** Маршрут, чья линия расходится с его же тёзкой: случай для человека. */
export interface NamesakeConflict {
  routeId: string;
  routeTitle: string;
  placeTitle: string;
  offTrackKm: number;
}

export interface LinkInput {
  routeId: string;
  routeTitle: string;
  /** Линия маршрута; меньше двух точек — судить нечем. */
  track: GeoPoint[];
  /** Доказана ли линия как запись прибора (lib/routes/track-evidence). */
  lineProven: boolean;
  waypoints: Array<{ placeId: string; placeTitle: string; lat: number; lng: number }>;
}

/**
 * Привязки, опровергнутые собственным треком маршрута.
 *
 * Порог — общий с полевым экраном и с чертой (`DATA_CONFLICT_KM`). Свой порог
 * здесь означал бы, что «расхождение» при уборке и «расхождение» при отказе
 * вести — разные величины, а это одно утверждение о данных.
 */
export interface BrokenLinksResult {
  /** Привязки, которые можно снимать: линия доказана, точка ей чужая. */
  candidates: LinkCandidate[];
  /**
   * Расхождения с ТЁЗКОЙ маршрута — снимать нельзя, показать человеку.
   *
   * Здесь под подозрением линия, а не привязка, и автоматика выбрала бы
   * неверную сторону.
   */
  namesakeConflicts: NamesakeConflict[];
}

export function brokenLinks(i: LinkInput): BrokenLinksResult {
  if (!i.lineProven || i.track.length < 2) return { candidates: [], namesakeConflicts: [] };
  const candidates: LinkCandidate[] = [];
  const namesakeConflicts: NamesakeConflict[] = [];
  for (const w of i.waypoints) {
    const proj = projectOnTrack({ lat: w.lat, lng: w.lng }, i.track);
    // `null` — спроецировать не удалось: это незнание, а не расхождение.
    if (!proj) continue;
    if (proj.offTrackKm <= DATA_CONFLICT_KM) continue;
    const offTrackKm = Math.round(proj.offTrackKm * 10) / 10;
    if (isNamesakeOfRoute(i.routeTitle, w.placeTitle)) {
      namesakeConflicts.push({
        routeId: i.routeId, routeTitle: i.routeTitle, placeTitle: w.placeTitle, offTrackKm,
      });
      continue;
    }
    candidates.push({
      routeId: i.routeId,
      routeTitle: i.routeTitle,
      placeId: w.placeId,
      placeTitle: w.placeTitle,
      offTrackKm,
    });
  }
  return { candidates, namesakeConflicts };
}

/**
 * Сколько привязок можно снять у ОДНОГО маршрута за раз.
 *
 * Если у маршрута опровергнуты все точки до единой, дело, скорее всего, не в
 * привязках: перепутан маршрут целиком или линия принадлежит другому пути.
 * Снести всё разом значило бы молча замести такой случай под ковёр — а его
 * должен увидеть человек.
 */
export const MAX_LINKS_PER_ROUTE = 3;

/**
 * Можно ли чинить этот маршрут автоматически.
 *
 * `false` — случай для человека: опровергнуто слишком много, и вопрос уже не
 * в отдельной привязке.
 */
export function safeToRepair(broken: number, total: number): boolean {
  if (broken === 0) return false;
  if (broken > MAX_LINKS_PER_ROUTE) return false;
  // Все точки опровергнуты — маршрут противоречит себе целиком.
  return broken < total;
}
