/**
 * lib/planner/plan-ops.ts — правила правки списка дней плана (#2224, шаг 2).
 *
 * Одни правила на обе двери правки: диалог (edit_trip_plan →
 * lib/planner/plan-edit) и кнопки веб-планера (/planner). До этого кнопки
 * жили по своим правилам: «удалить» снимало любой день, включая переезд
 * между зонами и середину многодневного тура; «добавить маршрут днём»
 * ставило день ПОСЛЕ дня отъезда; перетаскивание могло унести прилёт в
 * середину поездки.
 *
 * Модуль без зависимостей от базы и движка (только типы) — его читает и
 * сервер, и браузер. Номер дня здесь не пересчитывается: у веб-планера
 * `day` — постоянный ключ карточки (транспорт, отметки, ключ React), а дата
 * считается по позиции; у диалога `day` — позиция, и перенумерует его
 * plan-edit. Общее — что можно трогать и куда ставить, а не нумерация.
 */

/**
 * Минимум дня, по которому судят правила. Шире, чем DayPlan движка: у
 * веб-планера свой тип дня (app/planner/planner-types), и правила обязаны
 * принимать оба.
 */
interface DayLike {
  type: string;
  title?: string;
  realTour?: { tourId: string } | null;
}

/** Дни, которые правка двигает, убирает и заменяет. */
export const MOVABLE_TYPES: ReadonlySet<string> = new Set(['activity', 'rest', 'buffer']);

/** Каркас поездки — словами, для отказа. */
export const FRAME_WORD: Readonly<Record<string, string>> = {
  arrival: 'день прилёта', departure: 'день отъезда', travel: 'переезд между зонами',
};

/**
 * Почему день нельзя убрать, переставить или заменить. null — можно.
 * Прилёт, отъезд и переезд держат поездку: без них она не сходится.
 */
export function frameReason(day: Pick<DayLike, 'type'>): string | null {
  if (MOVABLE_TYPES.has(day.type)) return null;
  return FRAME_WORD[day.type] ?? 'каркас поездки';
}

/** Дни одного многодневного тура: убираются и двигаются только вместе. */
export function tourGroup<T extends Pick<DayLike, 'realTour'>>(days: readonly T[], day: T): T[] {
  const id = day.realTour?.tourId;
  if (!id) return [day];
  return days.filter((d) => d.realTour?.tourId === id);
}

/**
 * Почему день нельзя заменить маршрутом с карты — словами для человека; null —
 * можно. Каркас поездки не заменяют, день многодневного тура — по одному не
 * заменяют (его убирают целиком). Одна строка на кнопку «Заменить», плашку
 * карты и отказ правки: прежде карта обещала «нажмите точку — она встанет
 * вместо этого дня» и дню прилёта, а отказ уходил на скрытую вкладку (22.10).
 */
export function replaceRefusal<T extends Pick<DayLike, 'type' | 'realTour'>>(days: readonly T[], day: T): string | null {
  const why = replaceBlock(days, day);
  if (why === null) return null;
  if (why.kind === 'frame') return `Это ${why.frame} — его не заменяют маршрутом.`;
  return 'Это день многодневного тура — по одному дню его не заменяют. Уберите тур целиком и добавьте маршрут.';
}

/**
 * Та же причина отказа короткой строкой — для подписей, где фраза целиком не
 * помещается: заголовок списка дней и строка открытого дня (ревью 22.10,
 * третий круг: там стояло «кликните карту для замены» и у прилёта). Правило
 * одно с replaceRefusal: null у обеих в одних и тех же днях.
 */
export function replaceRefusalShort<T extends Pick<DayLike, 'type' | 'realTour'>>(days: readonly T[], day: T): string | null {
  const why = replaceBlock(days, day);
  if (why === null) return null;
  if (why.kind === 'frame') return `${why.frame} не заменяют`;
  return 'день тура не заменяют по одному';
}

type ReplaceBlock = { kind: 'frame'; frame: string } | { kind: 'tour' };

function replaceBlock<T extends Pick<DayLike, 'type' | 'realTour'>>(days: readonly T[], day: T): ReplaceBlock | null {
  const frame = frameReason(day);
  if (frame) return { kind: 'frame', frame };
  if (tourGroup(days, day).length > 1) return { kind: 'tour' };
  return null;
}

/** Куда встаёт новый день: перед отъездом, а если отъезда нет — в конец. */
export function insertIndex(days: readonly Pick<DayLike, 'type'>[]): number {
  const dep = days.findIndex((d) => d.type === 'departure');
  return dep >= 0 ? dep : days.length;
}

/**
 * Что сломано в порядке дней после перестановки. null — порядок годится.
 * Прилёт — первым, отъезд — последним, дни многодневного тура — подряд.
 */
export function orderProblem(days: readonly DayLike[]): string | null {
  const arrival = days.findIndex((d) => d.type === 'arrival');
  if (arrival > 0) return 'День прилёта остаётся первым.';
  const departure = days.findIndex((d) => d.type === 'departure');
  if (departure >= 0 && departure !== days.length - 1) return 'День отъезда остаётся последним.';
  const seen = new Set<string>();
  let prev: string | null = null;
  for (const d of days) {
    const id = d.realTour?.tourId ?? null;
    if (id && id !== prev) {
      if (seen.has(id)) return `Дни многодневного тура «${d.title}» идут подряд — его не разрывают.`;
      seen.add(id);
    }
    prev = id;
  }
  return null;
}
