/**
 * lib/build/commit-sha.ts — кто в РАНТАЙМЕ знает sha собранного образа.
 *
 * Зачем это отдельно от scripts/write-version.js. Тот скрипт исполняется
 * ВНУТРИ сборки Docker и видит только переменные, объявленные как `ARG`.
 * Если Timeweb передаёт sha приложению, но не в сборку, скрипт этого не
 * увидит НИКОГДА — а спросить надо, потому что #1762 упирается ровно в
 * вопрос «даёт ли провайдер sha хоть где-нибудь». Рантайм переменные
 * приложения видит целиком, и только он может на этот вопрос ответить.
 *
 * ВНИМАНИЕ, и это не формальность: найденный здесь sha — НЕ удостоверение
 * образа. Переменные живут в настройках приложения, а не в слоях образа:
 * контейнер, перезапущенный со свежей переменной на СТАРОМ образе, назовёт
 * чужой коммит. Удостоверение образа одно — public/version.json, записанный
 * в момент сборки. Здесь только разведка: есть ли у провайдера такое имя,
 * чтобы завести его в сборку (ARG) и получить честный маркер.
 *
 * Значения не возвращаются никогда. Наружу идут имена и семь знаков sha —
 * коммит и так публичен, а вот значение переменной может оказаться ключом.
 */

/**
 * Имена, из которых sha берёт сборка. ДУБЛЬ списка из
 * scripts/write-version.js — намеренный: тот скрипт исполняется в образе
 * простым CJS, без TS и без сборочных зависимостей, и импортировать отсюда
 * не может. Расхождение списков ловит tests/unit/build-sha-source.test.ts.
 */
export const SHA_ENV_NAMES = [
  'BUILD_COMMIT_SHA',
  'SOURCE_COMMIT',
  'GIT_COMMIT',
  'COMMIT_SHA',
  'GIT_SHA',
  'VCS_REF',
  'CI_COMMIT_SHA',
  'GITHUB_SHA',
] as const;

/** Полный sha — только он годится в кандидаты у НЕизвестного имени. */
const FULL_SHA = /^[0-9a-f]{40}$/;
/** У известного имени короткий sha тоже ответ: его пишет часть провайдеров. */
const ANY_SHA = /^[0-9a-f]{7,40}$/;

/**
 * Имена, которые почти наверняка держат секрет. Сорок hex — это и форма
 * многих ключей; показывать даже имя такой переменной в диагностике незачем.
 */
const SECRET_SHAPED = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|SIGNATURE|SALT|SESSION|COOKIE|DSN|URL|URI|CONN)/i;

export interface EnvShaSighting {
  /** Имя переменной. */
  name: string;
  /** Семь знаков — ровно столько, сколько сверяет проверка деплоя. */
  prefix: string;
  /** Полная длина значения: 40 — полный sha, меньше — короткий. */
  length: number;
  /** Имя из списка сборки (можно завести ARG) или найденное разведкой. */
  declared: boolean;
}

/**
 * Все переменные окружения, чьё значение похоже на sha коммита.
 *
 * Известные имена (SHA_ENV_NAMES) принимаются с 7 знаков; незнакомые — только
 * полные 40 hex и только если имя не секретообразное. Порядок: сперва
 * известные (в порядке доверия), потом найденные, по алфавиту.
 */
export function shaShapedEnvNames(env: NodeJS.ProcessEnv = process.env): EnvShaSighting[] {
  const declared: EnvShaSighting[] = [];
  for (const name of SHA_ENV_NAMES) {
    const raw = String(env[name] ?? '').trim().toLowerCase();
    if (ANY_SHA.test(raw)) {
      declared.push({ name, prefix: raw.slice(0, 7), length: raw.length, declared: true });
    }
  }

  const known = new Set<string>(SHA_ENV_NAMES);
  const found: EnvShaSighting[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (known.has(name) || SECRET_SHAPED.test(name)) continue;
    const raw = String(value ?? '').trim().toLowerCase();
    if (FULL_SHA.test(raw)) {
      found.push({ name, prefix: raw.slice(0, 7), length: raw.length, declared: false });
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name));

  return [...declared, ...found];
}

/**
 * Имена из списка сборки, ЗАДАННЫЕ в рантайме, — включая заданные неверно.
 * Отличать «переменной нет» от «переменная есть, но в ней не sha» надо: в
 * первом случае просят панель, во втором чинят значение.
 */
export function declaredEnvNamesSet(env: NodeJS.ProcessEnv = process.env): {
  ok: string[];
  malformed: string[];
} {
  const ok: string[] = [];
  const malformed: string[] = [];
  for (const name of SHA_ENV_NAMES) {
    const raw = String(env[name] ?? '').trim().toLowerCase();
    if (!raw) continue;
    (ANY_SHA.test(raw) ? ok : malformed).push(name);
  }
  return { ok, malformed };
}
