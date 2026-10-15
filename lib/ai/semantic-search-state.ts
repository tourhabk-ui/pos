/**
 * Поиск по смыслу: флаг SEMANTIC_SEARCH и состояние локальной модели
 * эмбеддингов (аудит 15.10, A21, решение (б) главной сессии по карт-бланшу
 * владельца).
 *
 * Модель MiniLM грузится лениво прямо в веб-процессе (lib/ai/embeddings.ts),
 * а прод — 2 ядра и 4 ГБ на всё (§6.1). Загружается ли она там вообще и
 * сколько памяти берёт, не измерял никто: зовущие глушили отказ в пустоту, а
 * health не говорил ни о модели, ни о памяти. Решение (б): поведение без
 * данных не меняется (флаг по умолчанию включён), но выключить модель можно
 * переменной в панели Timeweb, а health называет память процесса и состояние
 * модели — чтобы решать по числам, а не по догадке.
 *
 * Модуль лёгкий намеренно: его читает /api/health, и тянуть туда базу или
 * @huggingface/transformers ради трёх полей нельзя.
 */

/** Имя переменной окружения. Задаётся в панели Timeweb, не в коде. */
export const SEMANTIC_SEARCH_ENV = 'SEMANTIC_SEARCH';

/**
 * Значения, которые ВЫКЛЮЧАЮТ поиск по смыслу. Список явный и короткий:
 * всё прочее — включено, как было до флага. Пусто или переменной нет — тоже
 * включено: умолчание «как сейчас» (решение (б)).
 */
const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off']);

export function parseSemanticSearchFlag(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  return !OFF_VALUES.has(raw.trim().toLowerCase());
}

export function semanticSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseSemanticSearchFlag(env[SEMANTIC_SEARCH_ENV]);
}

/**
 * Модель попросили при выключенном флаге. Отдельный класс, чтобы зовущий,
 * забывший проверить флаг, получил отказ, а не тихую загрузку модели.
 */
export class SemanticSearchDisabledError extends Error {
  constructor() {
    super(`поиск по смыслу выключен флагом ${SEMANTIC_SEARCH_ENV}`);
    this.name = 'SemanticSearchDisabledError';
  }
}

// ── Состояние модели ─────────────────────────────────────────────────────

/** Что health говорит о модели. «Не загружена» — никто ещё не искал. */
export type EmbeddingModelState = 'disabled' | 'not_loaded' | 'loading' | 'loaded' | 'load_failed';

type LoadPhase = Exclude<EmbeddingModelState, 'disabled'>;

interface ModelRecord {
  phase: LoadPhase;
  /** Когда фаза началась (ISO). null — ещё ни разу не грузили. */
  since: string | null;
  /** Сколько длилась загрузка, мс; null — не кончилась или не начиналась. */
  load_ms: number | null;
  /** Почему не загрузилась — первые 200 знаков; null — не падала. */
  error: string | null;
}

// Состояние живёт на globalThis, а не в переменной модуля: /api/health и
// поиск — разные бандлы роутов, и копия модуля в одном из них сказала бы
// «не загружена» при загруженной модели. Тот же приём —
// lib/mesh/signaling-store.ts.
const MODEL_KEY = Symbol.for('vedar.embeddingModel');
type Holder = typeof globalThis & { [MODEL_KEY]?: ModelRecord };

function modelRecord(): ModelRecord {
  const g = globalThis as Holder;
  let r = g[MODEL_KEY];
  if (!r) {
    r = { phase: 'not_loaded', since: null, load_ms: null, error: null };
    g[MODEL_KEY] = r;
  }
  return r;
}

export function markModelLoading(at: Date = new Date()): void {
  Object.assign(modelRecord(), { phase: 'loading', since: at.toISOString(), load_ms: null, error: null });
}

export function markModelLoaded(loadMs: number, at: Date = new Date()): void {
  Object.assign(modelRecord(), { phase: 'loaded', since: at.toISOString(), load_ms: loadMs, error: null });
}

export function markModelLoadFailed(err: unknown, loadMs: number, at: Date = new Date()): void {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  Object.assign(modelRecord(), { phase: 'load_failed', since: at.toISOString(), load_ms: loadMs, error: message });
}

export interface EmbeddingModelStatus {
  enabled: boolean;
  state: EmbeddingModelState;
  since: string | null;
  load_ms: number | null;
  error: string | null;
}

/**
 * Состояние для health. Флаг выключен — «disabled»: модель в этом процессе
 * не грузится вовсе (lib/ai/embeddings.ts отказывает до импорта).
 */
export function embeddingModelStatus(env: NodeJS.ProcessEnv = process.env): EmbeddingModelStatus {
  const enabled = semanticSearchEnabled(env);
  const r = modelRecord();
  if (!enabled) return { enabled, state: 'disabled', since: null, load_ms: null, error: null };
  return { enabled, state: r.phase, since: r.since, load_ms: r.load_ms, error: r.error };
}

// ── Строка в лог при выключенном флаге ───────────────────────────────────

const notedOff = new Set<string>();

/**
 * Зовущий пошёл по совпадению слов, потому что флаг выключен. Это решение, а
 * не отказ, — но молча его делать нельзя: «по смыслу ничего не нашлось» и «по
 * смыслу не искали» — разные факты (§4.0). Одна строка на процесс и место:
 * флаг за жизнь процесса не меняется, и строка на каждый запрос была бы шумом.
 */
export function noteSemanticSearchOff(scope: string): void {
  if (notedOff.has(scope)) return;
  notedOff.add(scope);
  console.warn(`[${scope}] поиск по смыслу выключен флагом ${SEMANTIC_SEARCH_ENV} — ищу по совпадению слов`);
}
