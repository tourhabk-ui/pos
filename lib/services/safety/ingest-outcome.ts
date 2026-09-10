/**
 * Почему источник ничего не вставил.
 *
 * Повод — разбор #883. Канал ВК в отчёте выглядел мёртвым: `events_found: 32`,
 * `inserted: 0`. На деле он работал, а строки уже лежали в таблице — их за
 * минуты до того положил внутренний heartbeat (`start.js` дёргает GET каждые
 * 5 минут, воркфлоу POST'ит примерно раз в час). Ноль означал «всё уже здесь»,
 * а читался как «канал не приносит ничего», и на это ушёл целый разбор.
 *
 * Корень в том, что `inserted: 0` — это ЧЕТЫРЕ разных события, слипшихся в
 * одно число:
 *
 *   не запускали           источник в этом наблюдателе вообще не трогали;
 *   сходили, пусто         источник ответил, но не дал ни одного поста;
 *   разобрали, не вставили посты пришли, классифицировались, но все ключи
 *                          уже в базе — это ЗДОРОВЬЕ, а не поломка;
 *   сходили и упали        сеть/API/БД отдали ошибку.
 *
 * Между «здоровьем» и «поломкой» тут ровно та же граница, что у блока свежести
 * на главной: показать недоступность как норму — соврать, показать норму как
 * недоступность — поднять ложную тревогу. На канале МЧС ложная тревога дороже.
 *
 * Модуль СОЗНАТЕЛЬНО ничего не решает про здоровье источника: `SourceStatus` и
 * логика мёртвых каналов (`source-health.ts`) не меняются. Здесь только
 * наблюдаемость — отдельная величина рядом со счётчиками. Свести их вместе
 * можно будет, когда у ингеста останется один планировщик (пункт B в #883).
 */

export type IngestOutcome =
  /** Ключа окружения нет — источник не подключён (не поломка). */
  | 'not_configured'
  /** Этот наблюдатель источник не запускал. Не путать с «источник молчит». */
  | 'not_fetched'
  /** Сходили, источник ответил, но постов нет. */
  | 'fetched_zero'
  /** Посты есть, но ни один не оказался угрозой — классификатор отсеял всё. */
  | 'fetched_nothing_relevant'
  /** Разобрали события, но все ключи уже в базе. Штатное состояние. */
  | 'classified_but_not_inserted'
  /** Что-то вставлено. */
  | 'inserted'
  /** Поход за данными или запись упали. */
  | 'fetch_failed';

/** Человекочитаемое пояснение — чтобы отчёт не требовал чтения кода. */
export const OUTCOME_LABEL: Record<IngestOutcome, string> = {
  not_configured: 'источник не подключён (нет ключа окружения)',
  not_fetched: 'этот запуск источник не опрашивал',
  fetched_zero: 'источник ответил, постов нет',
  fetched_nothing_relevant: 'посты есть, угроз среди них нет',
  classified_but_not_inserted: 'события уже в базе — вставлять нечего',
  inserted: 'записаны новые события',
  fetch_failed: 'источник или запись отдали ошибку',
};

/**
 * Кто запустил прогон. Без этого поля отчёт нечитаем: один и тот же источник
 * даёт разные числа в зависимости от того, кто пришёл первым.
 */
export type IngestTrigger =
  /** Супервизор в контейнере, `start.js` → GET, каждые 5 минут. */
  | 'heartbeat_get'
  /** GitHub Actions → POST, приносит данные, которые сервер не может достать сам. */
  | 'workflow_post';

export const TRIGGER_LABEL: Record<IngestTrigger, string> = {
  heartbeat_get: 'heartbeat GET (start.js, каждые 5 минут)',
  workflow_post: 'workflow POST (GitHub Actions)',
};

export interface OutcomeInput {
  /** undefined — наблюдатель этот источник не запускал. */
  result?: {
    events: unknown[];
    inserted: number;
    skipped: number;
    errors: string[];
    rawItems?: number;
  };
  /** Имя env-переменной, без которой источник не работает. */
  requiresEnv?: string;
  /** Значение переменной. Передаём снаружи, чтобы функция осталась чистой. */
  envValue?: string | undefined;
}

export function ingestOutcome({ result, requiresEnv, envValue }: OutcomeInput): IngestOutcome {
  // Порядок проверок существенен: «не подключён» сильнее «не запускали»,
  // иначе неподключённый источник каждый раз выглядел бы пропущенным.
  if (requiresEnv && !envValue) return 'not_configured';
  if (!result) return 'not_fetched';

  if (result.inserted > 0) return 'inserted';

  // Ошибка важнее пустоты: источник, который упал, не должен выглядеть тихим.
  // Но только когда вставок нет — частичный сбой при удачных вставках честнее
  // показать как 'inserted', а сами ошибки и так уезжают в общий список.
  if (result.errors.length > 0) return 'fetch_failed';

  if (result.skipped > 0) return 'classified_but_not_inserted';

  // Дальше вставок нет, ошибок нет, дублей нет — значит нечего было вставлять.
  // rawItems заполняют не все источники, поэтому отличить «постов не дали» от
  // «дали, но всё отсеяно» можно лишь там, где счётчик сырых постов есть.
  if (result.rawItems === undefined) return 'fetched_zero';
  return result.rawItems > 0 ? 'fetched_nothing_relevant' : 'fetched_zero';
}

/**
 * Полный отчёт по одному источнику за один прогон.
 *
 * Имена полей выбраны так, чтобы их нельзя было прочитать неправильно:
 *   fetched          — ходили ли к источнику В ЭТОМ прогоне. Это про
 *                      наблюдателя, НЕ про здоровье канала;
 *   skipped_conflict — вместо голого `skipped`: ноль здесь значит «дублей не
 *                      было», а не «что-то пропустили».
 */
export interface SourceReport {
  outcome: IngestOutcome;
  /** Пояснение словами — чтобы отчёт не требовал чтения кода. */
  outcome_label: string;
  /** Ходил ли ЭТОТ прогон к источнику. false = намеренно не опрашивали. */
  fetched: boolean;
  /** Сырых постов до классификации. null — источник счётчик не заполняет. */
  raw_items: number | null;
  /** Сколько событий получилось после классификации. */
  classified: number;
  inserted: number;
  /** Столкнулись с уже существующим ключом — идемпотентность, не потеря. */
  skipped_conflict: number;
  errors: string[];
}

export function sourceReport(input: OutcomeInput): SourceReport {
  const outcome = ingestOutcome(input);
  const r = input.result;
  return {
    outcome,
    outcome_label: OUTCOME_LABEL[outcome],
    // not_configured тоже «не ходили», но причина другая и она в outcome.
    fetched: !!r && outcome !== 'not_configured',
    raw_items: r?.rawItems ?? null,
    classified: r?.events.length ?? 0,
    inserted: r?.inserted ?? 0,
    skipped_conflict: r?.skipped ?? 0,
    errors: r?.errors ?? [],
  };
}

/**
 * Чем закончился ПРОГОН — по источникам, которыми этот запуск владеет.
 *
 * Повод — #1759. С 02:37 до ~23:50 09.09 каждый пост каждого источника падал
 * на 42702 (#1745), `fetch_failed` в журнале решений вырос с 20 до 1031 — а
 * heartbeat все двадцать часов писал `'success'` безусловно. Сторожа серии
 * (`cron-fruitless` меряет `status !== 'success'`, `cron-failing` — `failed`)
 * читали ложь и молчали ПО ПОСТРОЕНИЮ. Третий исход §4.0, выданный за первый,
 * ровно в самом чувствительном месте.
 *
 * Правило:
 *   failed   — ни один источник запуска не отработал без ошибки и ничего не
 *              вставлено; пустой список источников — тоже failed: «ноль
 *              результатов при нулевом входе — отказ, а не успех»;
 *   partial  — ошибки были, но что-то вставилось или часть источников чиста;
 *   success  — ошибок нет.
 *
 * Считать ТОЛЬКО по своим источникам обязательно: heartbeat-GET не может
 * достать t.me (гео-закрыт с хостинга), и если судить его по kbgsras/eqkam,
 * каждый GET станет `partial` навсегда — вечная ложная тревога, которую
 * начнут обходить. Владение источниками — то же, что у записей здоровья.
 */
export type IngestRunStatus = 'success' | 'partial' | 'failed';

export interface RunSource {
  label: string;
  errors: readonly string[];
  inserted: number;
}

export function ingestRunStatus(sources: readonly RunSource[]): IngestRunStatus {
  if (sources.length === 0) return 'failed';
  const failed = sources.filter((s) => s.errors.length > 0);
  if (failed.length === 0) return 'success';
  const anyClean = sources.some((s) => s.errors.length === 0);
  const anyInserted = sources.some((s) => s.inserted > 0);
  return anyClean || anyInserted ? 'partial' : 'failed';
}

/**
 * Что именно упало — поимённо, для строки алерта.
 *
 * Читается `formatFruitlessCrons` из `metadata.empty_reasons[0]`: без адреса
 * тревога называет класс беды, а чинят конкретный источник и конкретную
 * ошибку. Текст ошибки режется — в нём бывает эхо запроса.
 */
export function ingestRunDetail(sources: readonly RunSource[]): string[] {
  return sources
    .filter((s) => s.errors.length > 0)
    .map((s) => `${s.label}: ${s.errors[0].slice(0, 160)}`);
}
