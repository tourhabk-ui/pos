/**
 * lib/agents/migration-startup-state.ts
 *
 * Исход наката миграций при старте ЭТОГО контейнера — для /api/cron/health
 * (аудит 15.10, A08, ответ на вопрос 8).
 *
 * Отказ наката сервер не роняет: SOS-мост, сейсмо-ингест и офлайн-пакеты
 * поля важнее новой фичи, которой нужна колонка. Но молчать отказ не вправе —
 * до 15.10 он оставался строкой «(continuing)» в логе выката. Теперь start.js
 * передаёт исход в Next через env MIGRATIONS_STARTUP_STATE (JSON), а крон
 * health будит им владельца.
 *
 * Чем это отличается от Watchdog, который читает `_migration_failures`: та
 * таблица знает только файлы, упавшие ВНУТРИ раннера. Таймаут наката, база,
 * не пустившая раннер, и раннер, не запустившийся вовсе, туда не доходят
 * никогда — а контейнер после них живёт на старой схеме так же.
 *
 * Состояний три (§4.0): ok, failed и unknown — «отчёта нет или он
 * нечитаем». Третье не равно первому: health о нём предупреждает.
 */

export type StartupMigrationsKind = 'ok' | 'failed' | 'unknown';

export interface StartupMigrationsState {
  state: StartupMigrationsKind;
  /** Почему именно так: applied, file_failed, timeout, fatal, exit_N, … */
  reason: string;
  /** Файл миграции, на котором накат упал или стоял; null — неизвестно какой. */
  file: string | null;
  sqlstate: string | null;
  failed_count: number | null;
  /** ISO-время итога наката; null — не записано. */
  at: string | null;
}

/** Имя переменной окружения Next, которую заполняет start.js. */
export const STARTUP_MIGRATIONS_ENV = 'MIGRATIONS_STARTUP_STATE';

// Те же формы, что проверяет start.js: в ответ health и в Telegram попадают
// только имя файла миграции и SQLSTATE — без текста ошибки, который умеет
// цитировать значения (телефон туриста).
const FILE_RE = /^[A-Za-z0-9_.-]{1,200}\.sql$/;
const SQLSTATE_RE = /^(?:[0-9][0-9A-Z]|XX|P0|HV|F0)[0-9A-Z]{3}$/;
const REASON_RE = /^[A-Za-z0-9_]{1,40}$/;
const KINDS: readonly StartupMigrationsKind[] = ['ok', 'failed', 'unknown'];

function unknownState(reason: string): StartupMigrationsState {
  return { state: 'unknown', reason, file: null, sqlstate: null, failed_count: null, at: null };
}

/** Разобрать значение env. Пусто или мусор — «неизвестно», с причиной. */
export function parseStartupMigrationsState(raw: string | undefined): StartupMigrationsState {
  if (raw === undefined || raw.trim() === '') return unknownState('not_recorded');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownState('unreadable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unknownState('unreadable');
  const o = parsed as Record<string, unknown>;
  const state = KINDS.find((k) => k === o.state);
  if (!state) return unknownState('unreadable');
  const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
  return {
    state,
    reason: str(o.reason, REASON_RE) ?? 'unspecified',
    file: str(o.file, FILE_RE),
    sqlstate: str(o.sqlstate, SQLSTATE_RE),
    failed_count: typeof o.failed_count === 'number' && Number.isInteger(o.failed_count) && o.failed_count >= 0
      ? o.failed_count
      : null,
    at: typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) ? o.at : null,
  };
}

function failureDetail(m: StartupMigrationsState): string {
  const file = m.file ?? 'неизвестно какой файл';
  const code = m.sqlstate ? `, SQLSTATE ${m.sqlstate}` : '';
  const more = m.failed_count !== null && m.failed_count > 1 ? `; всего упавших файлов: ${m.failed_count}` : '';
  switch (m.reason) {
    case 'file_failed': return `упала миграция ${file}${code}${more}`;
    case 'timeout': return `накат не уложился в MIGRATE_TIMEOUT_MS и оборван (стоял на ${file})`;
    case 'fatal': return `раннер не дошёл до файлов${code}`;
    case 'interrupted': return `раннер оборвался на ${file}`;
    default: return `раннер завершился аварийно (${m.reason}), файл: ${file}${code}`;
  }
}

/**
 * Находка health-крона. failed — CRIT: схема отстаёт от кода, а код уже
 * раздаётся и рассчитывает на колонки, которых нет. unknown — WARN: health
 * не может сказать, отстаёт ли схема. ok — молчание.
 */
export function startupMigrationsIssue(
  m: StartupMigrationsState,
): { level: 'crit' | 'warn'; text: string } | null {
  const when = m.at ? ` (старт контейнера ${m.at})` : '';
  if (m.state === 'failed') {
    return {
      level: 'crit',
      text: `Схема БД отстаёт от кода: при старте контейнера${when} ${failureDetail(m)}. Сервер работает на прежней схеме — то, что ждёт новых колонок, падает. Текст ошибки — в логе выката и в _migration_failures (/hub/admin/migrations); повтор наката — следующий выкат`,
    };
  }
  if (m.state === 'unknown') {
    return {
      level: 'warn',
      text: `Исход наката миграций при старте контейнера неизвестен (${m.reason})${when}: start.js не получил отчёта раннера, и отстаёт ли схема от кода, health сказать не может`,
    };
  }
  return null;
}
