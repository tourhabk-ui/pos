/**
 * Автоматы, которые предлагают правки туров (слово владельца 23.11):
 * «Автоматы (кроны описаний и фото, импортёры) пишут в туры только через
 * очередь проверки, своих обходных путей у них нет».
 *
 * Автомат идёт той же дверью, что владелец тура (lib/tours/tour-change,
 * `saveTourChange`), и по тому же правилу: тур на сайте — правка черновиком
 * на проверку; тур, которого туристы не видят и который проверки не ждёт, —
 * запись в строку. Отличий два:
 *
 *   - поле, предложенное автоматом, помечено его именем (`proposed_by`,
 *     миграция 1511): администратор и владелец видят, чьё это предложение;
 *   - автомат не перебивает поле, которое владелец уже отправил на проверку,
 *     и не просит публикацию.
 *
 * Чистый модуль: ни базы, ни `node:*` — его читает клиентский код диффа.
 */
import { MODERATED_TOUR_COLUMNS, isModeratedTourColumn, sameTourValue, type ModeratedTourColumn, type TourContentPatch } from '@/lib/tours/moderation';

/**
 * Реестр: имя автомата → чем он занят, словами для человека. Автомат
 * заводится здесь в том же PR, в котором он начинает ходить через дверь:
 * имя без производителя — провод в никуда (CLAUDE.md §4).
 */
export const TOUR_AUTOMATA = {
  'tour-describe': 'сборка описания из данных тура',
  'tour-photos': 'добавление снимков к туру',
  'tour-pickup': 'запись точки сбора',
  'ab-scale': 'скидка победившей группы ценового эксперимента',
  'initiative-rewrite': 'описание, переписанное моделью',
  'operator-site-import': 'импорт с сайта оператора',
} as const;

export type TourAutomaton = keyof typeof TOUR_AUTOMATA;

export function isTourAutomaton(value: unknown): value is TourAutomaton {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TOUR_AUTOMATA, value);
}

/** Чем занят автомат — словами. Незнакомое имя видно как записано, а не прячется. */
export function automatonWords(name: string): string {
  return isTourAutomaton(name) ? TOUR_AUTOMATA[name] : `автомат «${name}»`;
}

/** Пометки «кто предложил поле»: {колонка: имя автомата}. */
export type ProposedBy = Partial<Record<ModeratedTourColumn, string>>;

/** Только колонки содержания и непустые имена: чужой ключ пометкой не станет. */
export function cleanProposedBy(raw: unknown): ProposedBy {
  const out: ProposedBy = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isModeratedTourColumn(key) && typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * Что автомату можно положить в черновик. Поле, которое уже ждёт проверки и
 * пометки автомата не несёт, прислал владелец — оно остаётся как есть.
 * Своё прежнее предложение (или предложение другого автомата) заменить можно.
 */
export function automatonIncoming(
  content: TourContentPatch,
  pendingPatch: TourContentPatch,
  marksBefore: ProposedBy,
): { incoming: TourContentPatch; keptOwner: ModeratedTourColumn[] } {
  const incoming: TourContentPatch = {};
  const keptOwner: ModeratedTourColumn[] = [];
  for (const field of MODERATED_TOUR_COLUMNS) {
    if (!(field in content)) continue;
    if (field in pendingPatch && marksBefore[field] === undefined) keptOwner.push(field);
    else incoming[field] = content[field];
  }
  return { incoming, keptOwner };
}

/**
 * Пометки после правки. `patch` — итоговый черновик (только поля, которые
 * отличаются от витрины): пометка живёт, пока поле в нём есть.
 *
 *   - поле прислал автомат — пометка его;
 *   - поле прислал владелец и поменял предложенное — пометки нет: это уже
 *     его слово;
 *   - владелец прислал то же, что предложил автомат (форма шлёт себя целиком
 *     вместе с правкой на проверке), — пометка остаётся;
 *   - поле в этой правке не прислано — пометка прежняя.
 */
export function nextProposedBy(opts: {
  patch: TourContentPatch;
  pendingPatch: TourContentPatch;
  marksBefore: ProposedBy;
  incoming: TourContentPatch;
  source: TourAutomaton | null;
}): ProposedBy {
  const out: ProposedBy = {};
  for (const field of MODERATED_TOUR_COLUMNS) {
    if (!(field in opts.patch)) continue;
    const before = opts.marksBefore[field];
    if (field in opts.incoming) {
      if (opts.source !== null) out[field] = opts.source;
      else if (before !== undefined && field in opts.pendingPatch
        && sameTourValue(field, opts.pendingPatch[field], opts.incoming[field])) out[field] = before;
    } else if (before !== undefined) {
      out[field] = before;
    }
  }
  return out;
}

/** Пометки словами — для строки диффа «предложил автомат платформы: …». */
export function proposedByWords(marks: ProposedBy): Partial<Record<ModeratedTourColumn, string>> {
  const out: Partial<Record<ModeratedTourColumn, string>> = {};
  for (const field of MODERATED_TOUR_COLUMNS) {
    const name = marks[field];
    if (name !== undefined) out[field] = automatonWords(name);
  }
  return out;
}

/** Поля черновика, предложенные автоматом, и поля владельца — по пометкам. */
export function splitByAuthor(fields: readonly ModeratedTourColumn[], marks: ProposedBy): {
  automaton: ModeratedTourColumn[];
  owner: ModeratedTourColumn[];
} {
  return {
    automaton: fields.filter((f) => marks[f] !== undefined),
    owner: fields.filter((f) => marks[f] === undefined),
  };
}
