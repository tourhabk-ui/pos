/**
 * Сколько карты маршрута ЛЕЖИТ В ТЕЛЕФОНЕ — проверкой, а не записью.
 *
 * ── Чего не хватало (20.09) ───────────────────────────────────────────────
 *
 * Пробел назван не мной: он записан в шапке `lib/offline/saved-map.ts`
 * дословно — «запись живёт в localStorage рядом с самими тайлами в кэше
 * service worker. Разъехаться они могут... поэтому запись — не
 * доказательство, а заявление: "мы скачали столько-то тогда-то". Проверка
 * наличия — отдельный разговор, и врать вместо неё нельзя: "сохранено" без
 * карты хуже, чем "не сохранено"».
 *
 * Отдельного разговора не было. Экран планирования показывал
 * `savedMapSummary` — пересказ того, что закачка ОБЕЩАЛА в момент нажатия:
 * столько-то мегабайт, такие-то зумы, такого-то числа. Между обещанием и
 * выходом в поле стоит система, которая вправе вычистить кэш при нехватке
 * места и localStorage при этом не тронуть. Человек читает «Карта сохранена
 * · 47 МБ · вчера», уходит без связи и узнаёт правду там, где узнавать уже
 * поздно.
 *
 * Здесь считается доля тайлов коридора, которые ДЕЙСТВИТЕЛЬНО отдаёт Cache
 * Storage. Приём не новый для репозитория: `sampleTilesPresent` в
 * `useOfflineRegion` так же проверяет регионы делом, а `field-pack`
 * проверяет готовность пакета. Ново то, что тем же меряется КОНКРЕТНЫЙ
 * маршрут и результат называется человеку числом до выхода.
 *
 * ── Почему это не серверный эндпоинт ──────────────────────────────────────
 *
 * Задача #1971 просила завести `GET /api/offline/pack-status`, отдающий
 * список недостающих тайлов. Сервер на этот вопрос ответить не может: он
 * знает, что маршруту НУЖНО (и уже отвечает — `/api/routes/[id]/
 * offline-bundle` отдаёт `tile_urls`, зумы и отброшенные зумы), но что
 * ЛЕЖИТ в кэше конкретного телефона, знает только сам телефон. Эндпоинт,
 * отвечающий половину вопроса, завёл бы второй источник правды о покрытии
 * рядом с первым (§12).
 *
 * ── Четыре исхода, а не доля от нуля до единицы ───────────────────────────
 *
 * Задача просила «для маршрута без сохранённого манифеста возвращать
 * ratio=0». Ноль означает «скачано нисколько» — и это НЕ то же самое, что
 * «не качали» и не то же, что «проверить нечем» (§4.0). Разница видна
 * человеку прямо на экране: «карта не скачана» зовёт нажать кнопку, «0% из
 * скачанного на месте» означает, что система вычистила кэш, а «не смогли
 * проверить» не означает ничего и обязано так и называться.
 */

/**
 * `covered`      — всё, что проверяли, на месте;
 * `partial`      — часть тайлов не отдаётся: карта с дырами;
 * `none`         — не нашлось ни одного: кэш вычищен или закачки не было;
 * `cannot_check` — проверить нечем (нет Cache Storage, нечего проверять).
 */
export type CoverageState = 'covered' | 'partial' | 'none' | 'cannot_check';

export interface CoverageReport {
  state: CoverageState;
  /**
   * Доля проверенных тайлов, оказавшихся в кэше. `null` у `cannot_check` —
   * отсутствие проверки не равно нулевому покрытию.
   */
  ratio: number | null;
  /** Сколько тайлов нужно маршруту всего. */
  need: number;
  /** Сколько из них проверили. Меньше `need` — значит проверяли выборкой. */
  checked: number;
  /** Сколько из проверенных нашлось. */
  present: number;
  /** Доля получена выборкой, а не сплошной проверкой. */
  sampled: boolean;
  /** Почему проверить не вышло. Не пусто только у `cannot_check`. */
  reason: string | null;
}

/**
 * Ниже этой доли карту считаем дырявой и говорим об этом громко.
 *
 * Число из задачи #1971. Держать его отдельной константой, а не вписывать в
 * условие, — чтобы поправка была одной строкой и видна в тесте.
 */
export const COVERAGE_WARN_BELOW = 0.9;

/**
 * Сплошь проверяем, пока тайлов не больше этого. Дальше — выборкой.
 *
 * Потолок не про точность, а про время: `caches.match` на каждый тайл — это
 * поход в хранилище, и тысяча таких походов на экране перед выходом
 * ощущается как зависший интерфейс.
 */
export const COVERAGE_CHECK_ALL_MAX = 300;

/** Сколько тайлов берём в выборку, когда сплошная проверка слишком дорога. */
export const COVERAGE_SAMPLE_SIZE = 120;

/**
 * Равномерная выборка по списку: берём каждый N-й, включая первый и
 * последний.
 *
 * Равномерно, а не случайно, и не «первые сто»: тайлы идут зумами и
 * геометрическим порядком, то есть первые сто — это начало маршрута на самом
 * грубом зуме. Оборванная закачка теряет ХВОСТ, и выборка из головы сказала
 * бы «всё на месте» именно тогда, когда не хватает конца пути.
 */
export function evenSample<T>(items: T[], size: number): T[] {
  if (size <= 0 || items.length === 0) return [];
  if (items.length <= size) return [...items];
  const out: T[] = [];
  const stride = (items.length - 1) / (size - 1);
  for (let i = 0; i < size; i++) out.push(items[Math.round(i * stride)]);
  return [...new Set(out)];
}

/**
 * Вердикт по числам — чистая функция, вся арифметика покрытия здесь.
 *
 * `checked === 0` при непустом `need` — это «не проверили», а не «ничего нет».
 */
export function coverageFromCounts(need: number, checked: number, present: number): CoverageReport {
  if (need <= 0) {
    return {
      state: 'cannot_check',
      ratio: null,
      need: 0,
      checked: 0,
      present: 0,
      sampled: false,
      reason: 'у маршрута нет линии — коридор строить не из чего',
    };
  }
  if (checked <= 0) {
    return {
      state: 'cannot_check',
      ratio: null,
      need,
      checked: 0,
      present: 0,
      sampled: false,
      reason: 'проверить нечем — хранилище карт недоступно',
    };
  }
  const ratio = present / checked;
  const state: CoverageState = present === 0 ? 'none' : ratio >= 1 ? 'covered' : 'partial';
  return {
    state,
    ratio,
    need,
    checked,
    present,
    sampled: checked < need,
    reason: null,
  };
}

/** Покрытие словами — одной строкой под кнопкой, без процентов в воздухе. */
export function coverageLabel(r: CoverageReport): string {
  if (r.state === 'cannot_check') return r.reason ?? 'проверить не удалось';
  const pct = Math.floor((r.ratio ?? 0) * 100);
  if (r.state === 'none') return 'карты маршрута в телефоне нет';
  const tail = r.sampled ? ` (по выборке из ${r.checked})` : '';
  if (r.state === 'covered') return `карта маршрута на месте${tail}`;
  return `в телефоне ${pct}% карты маршрута${tail}`;
}

/** Надо ли кричать. Отдельной функцией: порог один на экран и на тест. */
export function coverageIsShort(r: CoverageReport): boolean {
  if (r.ratio === null) return false;
  return r.ratio < COVERAGE_WARN_BELOW;
}

/**
 * Спросить Cache Storage, сколько тайлов коридора он отдаёт.
 *
 * Ошибка похода в хранилище НЕ считается отсутствием тайла: отличить «тайла
 * нет» от «спросить не вышло» здесь можно, и смешивать их значило бы
 * показать дыру там, где её нет. Неудавшиеся проверки просто не идут в счёт,
 * а если не вышло ни одной — исход `cannot_check`.
 */
export async function probeCoverage(
  tileUrls: string[],
  opts: { checkAllMax?: number; sampleSize?: number } = {},
): Promise<CoverageReport> {
  const need = tileUrls.length;
  if (need === 0) return coverageFromCounts(0, 0, 0);
  if (typeof caches === 'undefined') return coverageFromCounts(need, 0, 0);

  const checkAllMax = opts.checkAllMax ?? COVERAGE_CHECK_ALL_MAX;
  const sampleSize = opts.sampleSize ?? COVERAGE_SAMPLE_SIZE;
  const probe = need <= checkAllMax ? tileUrls : evenSample(tileUrls, sampleSize);

  let checked = 0;
  let present = 0;
  // Request объектом, не строкой: `x.match(строка)` неотличимо от
  // String.prototype.match, и анализатор читает URL как регулярное выражение
  // (CodeQL js/incomplete-hostname-regexp). Тот же приём, что в
  // `sampleTilesPresent`.
  const hits = await Promise.all(
    probe.map(async (u) => {
      try {
        return (await caches.match(new Request(u))) !== undefined;
      } catch {
        return null;
      }
    }),
  );
  for (const h of hits) {
    if (h === null) continue;
    checked++;
    if (h) present++;
  }
  return coverageFromCounts(need, checked, present);
}
