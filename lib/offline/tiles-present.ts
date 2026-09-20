/**
 * Лежат ли тайлы в телефоне НА САМОМ ДЕЛЕ — один ответ на всех, кто спрашивает.
 *
 * ── Повод (20.09) ─────────────────────────────────────────────────────────
 *
 * Запись о скачанной карте и сама карта живут в разных хранилищах. Система
 * вправе вычистить Cache Storage, не тронув ни localStorage, ни IndexedDB, —
 * и тогда запись остаётся, а карты нет. Это названо в шапке `saved-map.ts`
 * прямым текстом: «запись — не доказательство, а заявление».
 *
 * Проверка этого заявления к 20.09 существовала в двух копиях, и обе судили
 * слабо:
 *
 *  - `useOfflineRegion.ts` брал пробу `[первый, средний, последний]` и
 *    отвечал `hits.some(...)`;
 *  - `field-pack.ts` отвечал тем же `some` по тому, что ему передали;
 *  - `_PlanningClient.tsx` собирал ТУ ЖЕ тройку руками при сборке пакета.
 *
 * `some` значит «хоть один адрес на месте». Один уцелевший тайл из тысячи
 * читался как «карта на месте», а при пробе из трёх адресов это означало:
 * двух третей карты может не быть, и пакет пройдёт как готовый. Человек
 * узнаёт правду в поле — то есть тогда, когда сделать уже ничего нельзя.
 *
 * ── Что здесь есть ────────────────────────────────────────────────────────
 *
 * Два правила, и оба раньше жили не здесь: КАКУЮ пробу брать и КАК судить по
 * её итогу. Слов человеку тут нет намеренно: регион, полевой пакет и карта
 * маршрута говорят о пропаже по-разному, и общий текст пришлось бы писать
 * так обобщённо, что он перестал бы что-либо значить.
 *
 * ── Чего здесь нет ────────────────────────────────────────────────────────
 *
 * Уверенности. Проба — это проба: `present` значит «все проверенные адреса на
 * месте», а не «карта цела». Полная проверка тысячи адресов при каждом
 * монтировании стоит дороже, чем стоит ответ. Поэтому итог несёт `checked` и
 * `found` — кто хочет сказать точнее, скажет по числам, а не по ощущению.
 */

export type TilesPresenceState =
  /** Все проверенные адреса на месте. */
  | 'present'
  /** Часть пробы пропала — карта неполна. */
  | 'partial'
  /** Из пробы не нашлось ничего — карты нет. */
  | 'missing'
  /**
   * Проверить нечем: нет Cache Storage (SSR, приватный режим), нет адресов
   * для пробы, или обращение к хранилищу отказало. НЕ равно `present`
   * (§4.0: третий исход не равен первому).
   */
  | 'unknown';

export interface TilesPresence {
  state: TilesPresenceState;
  /** Сколько адресов реально спросили. */
  checked: number;
  /** Сколько из них нашлось. */
  found: number;
}

/**
 * Сколько адресов спрашивать.
 *
 * Прежняя тройка `[первый, средний, последний]` ловила ровно один сценарий —
 * кэш вычищен целиком. Список тайлов собирается блоками по зумам
 * (`planCorridor` идёт от грубого к детальному), и тройка попадает в первый
 * зум, в стык где-то посередине и в последний: целый зум между ними не
 * проверяется вовсе. Двенадцать адресов равным шагом дают по три на каждый из
 * четырёх зумов коридора.
 */
export const TILE_PROBE_SIZE = 12;

/**
 * Проба адресов равным шагом по всему списку.
 *
 * Равным, а не подряд: соседние тайлы — соседние квадраты на земле, они
 * пропадают и уцелевают вместе, и десяток подряд меряет один участок карты
 * вместо всей.
 */
export function sampleTileUrls(urls: string[], size: number = TILE_PROBE_SIZE): string[] {
  if (size < 1 || urls.length === 0) return [];
  if (urls.length <= size) return [...urls];

  const step = (urls.length - 1) / (size - 1);
  const picked = new Set<string>();
  for (let i = 0; i < size; i++) {
    const url = urls[Math.round(i * step)];
    if (url) picked.add(url);
  }
  return Array.from(picked);
}

/** Приговор по итогу пробы. Отдельно от запроса — чтобы его можно было проверить. */
export function judgeTilesPresence(checked: number, found: number): TilesPresence {
  if (checked === 0) return { state: 'unknown', checked: 0, found: 0 };
  if (found === 0) return { state: 'missing', checked, found };
  if (found === checked) return { state: 'present', checked, found };
  return { state: 'partial', checked, found };
}

/**
 * Спросить Cache Storage, на месте ли тайлы.
 *
 * `urls` — весь список адресов объекта либо уже готовая проба: лишнего
 * отбора не делается, `sampleTileUrls` вызывается здесь же и на короткий
 * список не влияет.
 */
export async function probeTilesPresent(
  urls: string[],
  opts: { size?: number } = {},
): Promise<TilesPresence> {
  if (typeof caches === 'undefined') return { state: 'unknown', checked: 0, found: 0 };

  const sample = sampleTileUrls(urls, opts.size ?? TILE_PROBE_SIZE);
  if (sample.length === 0) return { state: 'unknown', checked: 0, found: 0 };

  try {
    // Request объектом, не строкой: `x.match(строка)` неотличимо от
    // String.prototype.match, и анализатор читает URL как регулярное
    // выражение (CodeQL js/incomplete-hostname-regexp). Поведение то же.
    const hits = await Promise.all(sample.map((u) => caches.match(new Request(u))));
    return judgeTilesPresence(sample.length, hits.filter((h) => h !== undefined).length);
  } catch {
    // Хранилище отказало — это «не смогли спросить», а не «ничего нет».
    return { state: 'unknown', checked: 0, found: 0 };
  }
}

/** Доля найденного в пробе, 0..1. `null` — проверить было нечем. */
export function presenceRatio(p: TilesPresence): number | null {
  if (p.checked === 0) return null;
  return p.found / p.checked;
}
