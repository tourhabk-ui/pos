/**
 * lib/routes/cleanup-queue.ts
 *
 * Именованные очереди уборки: что именно мешает записи и что это установит.
 *
 * ── Почему очередь, а не чистка ────────────────────────────────────────────
 *
 * «Убрать плохие маршруты» звучит как одно действие, но за ним стоят вещи
 * несовместимой природы. Линия, у которой не установлена принадлежность,
 * выглядит безупречно и, скорее всего, верна — просто никто не подтвердил,
 * что она этого маршрута. Запись без линии вообще не о линии: это место,
 * которое числится маршрутом. Точка в двадцати километрах от линии — либо
 * ошибка привязки, либо ошибка самой линии, и разница решается уликой, а не
 * порогом.
 *
 * Свалить их в одну кучу «мусор» — значит либо удалить годное, либо оставить
 * опасное. Поэтому каждая запись попадает РОВНО В ОДНУ очередь, у очереди
 * есть причина машинным кодом и вопрос человеку: чем именно это закрывается.
 *
 * ── Никто ничего не удаляет ────────────────────────────────────────────────
 *
 * Очередь ничего не меняет и не пишет. Место остаётся местом, даже если
 * маршрутом не является: у записи меняется классификация и причина, а не
 * факт существования. Модуль только называет, что нужно установить.
 */

/** Причина, по которой запись стоит в очереди. Машинный код — по нему группируют. */
export type CleanupReason =
  /** Линия есть, но её принадлежность этому маршруту не установлена. */
  | 'donor_missing'
  /** Точка пути стоит далеко от линии: одно из двух неверно. */
  | 'waypoint_conflict'
  /** Линия есть, донор подтверждён, но путь не описан точками. */
  | 'no_path_described'
  /** Линии нет вовсе — запись описывает место, а не путь. */
  | 'no_line'
  /** Две записи об одном и том же. */
  | 'twin'
  /** Название коммерческое (тур, заброска), пути нет. */
  | 'commercial_title'
  /** Воздух или море: исправная запись, просто не пеший маршрут. */
  | 'not_on_foot';

export interface QueueItem {
  routeId: string;
  title: string;
  reason: CleanupReason;
  /** Что именно установит вопрос — словами, человеку, который будет решать. */
  settledBy: string;
  /** Подробность случая: расстояние, имя близнеца, число точек. */
  detail?: string;
}

/** Факты о записи, которых достаточно, чтобы назначить очередь. */
export interface RouteFacts {
  routeId: string;
  title: string;
  /** Линия из двух и более точек. */
  hasLine: boolean;
  /** Принадлежность линии подтверждена страницей-источником. */
  donorConfirmed: boolean;
  /** Путевых точек (род `waypoint` или `unknown`). */
  pathPoints: number;
  /** Спорная точка: отход от линии в километрах; null — спора нет. */
  conflictKm?: number | null;
  /** Способ передвижения не пеший (воздух, море). */
  notOnFoot?: boolean;
  /** Имя записи-близнеца, если есть. */
  twinOf?: string | null;
  /** Название опознано как коммерческое. */
  commercialTitle?: boolean;
}

const SETTLED_BY: Record<CleanupReason, string> = {
  donor_missing:
    'Страница-источник у самой карточки: адрес в source_url или ключ вида «источник:id». ' +
    'Без неё линия может принадлежать другому маршруту, и проверить это нечем',
  waypoint_conflict:
    'Разбор случая: если в стороне одна точка — снять привязку; если в стороне все — ' +
    'виновата линия, и снимать точки нельзя',
  no_path_described:
    'Две и более путевые точки от источника или GPS-запись прохождения. ' +
    'Вычисленные по линии ориентиры не годятся: они получены из неё же',
  no_line:
    'Решение о роде записи: это место (тогда переносить в places) или маршрут без линии ' +
    '(тогда линия импортируется отдельно). Удалять нечего — объект существует',
  twin: 'Слияние записей: какая из двух остаётся, куда переезжают связи и отзывы',
  commercial_title:
    'Решение о роде записи: коммерческое предложение — не маршрут. Переносить в operator_tours ' +
    'или переименовывать, если под названием всё же лежит путь',
  not_on_foot:
    'Ничего. Запись исправна: у облёта и переправы линию не проходят, и обещание ведения ' +
    'к ним не относится. Стоит в списке, чтобы её не считали браком',
};

/**
 * Назначить очередь. Порядок проверок — это приоритет: запись попадает ровно
 * в одну очередь, и первой спрашивается та причина, которая делает остальные
 * бессмысленными.
 *
 * Сначала «не пеший»: у облёта нет ни спора точек, ни вопроса о доноре — там
 * нечего чинить. Затем близнец: чинить обе записи об одном объекте значит
 * делать работу дважды. Затем то, что касается САМОЙ линии, и лишь потом
 * отсутствие линии.
 */
export function assignQueue(f: RouteFacts): QueueItem {
  const item = (reason: CleanupReason, detail?: string): QueueItem => ({
    routeId: f.routeId, title: f.title, reason, settledBy: SETTLED_BY[reason], detail,
  });

  if (f.notOnFoot) return item('not_on_foot');
  if (f.twinOf) return item('twin', `Близнец: ${f.twinOf}`);
  if (f.commercialTitle && f.pathPoints < 2) return item('commercial_title');
  if (!f.hasLine) return item('no_line', `Путевых точек: ${f.pathPoints}`);
  if (f.conflictKm != null) {
    return item('waypoint_conflict', `Точка стоит в ${f.conflictKm.toFixed(1)} км от линии`);
  }
  if (!f.donorConfirmed) return item('donor_missing');
  return item('no_path_described', `Путевых точек: ${f.pathPoints}`);
}

export interface CleanupQueues {
  /** Сколько записей в каждой очереди. */
  counts: Record<CleanupReason, number>;
  /** Поимённые образцы по каждой очереди — по ним и разбирают. */
  samples: Record<CleanupReason, QueueItem[]>;
  /** Всего записей в очередях. */
  total: number;
}

export const SAMPLES_PER_QUEUE = 20;

/** Собрать очереди из фактов. Ничего не читает и не пишет. */
export function buildQueues(facts: Iterable<RouteFacts>): CleanupQueues {
  const counts = {
    donor_missing: 0, waypoint_conflict: 0, no_path_described: 0,
    no_line: 0, twin: 0, commercial_title: 0, not_on_foot: 0,
  } as Record<CleanupReason, number>;
  const samples = {
    donor_missing: [], waypoint_conflict: [], no_path_described: [],
    no_line: [], twin: [], commercial_title: [], not_on_foot: [],
  } as Record<CleanupReason, QueueItem[]>;
  let total = 0;
  for (const f of facts) {
    const item = assignQueue(f);
    counts[item.reason] += 1;
    total += 1;
    if (samples[item.reason].length < SAMPLES_PER_QUEUE) samples[item.reason].push(item);
  }
  return { counts, samples, total };
}
