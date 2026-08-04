/**
 * lib/agents/migration-status.ts
 *
 * Миграция, которая не применилась, не должна молчать.
 *
 * `scripts/migrate-standalone.js` намеренно не роняет деплой на упавшей
 * миграции: пишет `✗ файл: причина`, считает ошибку и всё равно поднимает
 * сервер (`process.exitCode = 0`, «don't block server start»). Решение
 * защищает доступность — сервис не ложится из-за одной кривой миграции, и это
 * правильно для платформы, которой пользуются в поле.
 *
 * Но у него есть вторая половина, которой не было: провал остаётся строчкой в
 * логе деплоя. Никто не читает лог деплоя на следующий день. Схема тихо
 * расходится с кодом, а снаружи всё зелено — ровно тот же класс, что зелёный
 * KVERT с нулём вулканов и «6 из 12» у разведки.
 *
 * Отличить применённое от неприменённого можно детерминированно: файлы на диске
 * против строк в `_migrations`. Чистая функция — тестируется без БД.
 */

/** Имена файлов миграций, которых нет в таблице учёта. */
export function findUnappliedMigrations(
  files: readonly string[],
  applied: readonly string[],
): string[] {
  const done = new Set(applied);
  return files
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !done.has(f))
    .sort();
}

/**
 * Бюджет символов на перечисление имён. Обрезка по счётчику («первые 5») прятала
 * половину списка: на проде их восемь, и три оставались безымянными — чтобы
 * узнать какие, приходилось лезть в базу. Имя миграции — это и есть вся
 * полезная нагрузка алерта, поэтому режем по длине сообщения, а не по числу.
 */
const NAMES_BUDGET = 900;

/** Длина причины в сообщении: хватает на текст ошибки Postgres. */
const REASON_LIMIT = 200;

/**
 * Человекочитаемая строка для Telegram.
 *
 * `reasons` — записанные причины падения (`_migration_failures`) по именам. До
 * 04.08 симптом и причина ехали в РАЗНЫХ алертах: «миграции не применились: 796,
 * 800, 806 — смотри лог деплоя» приходило отдельно от «806: column ... does not
 * exist», а лог деплоя на следующий день никто не открывает. Отправлять человека
 * искать то, что у нас уже есть в базе, — тот же класс, что и сам молчащий
 * провал. Теперь причина едет вместе с именем; «смотри лог» остаётся только для
 * тех, у кого записи о падении нет (миграция вообще не запускалась).
 */
export function formatUnappliedMigrations(
  unapplied: readonly string[],
  reasons: Readonly<Record<string, string>> = {},
): string {
  const shown: string[] = [];
  let used = 0;
  for (const name of unapplied) {
    const cost = name.length + 2;
    if (used + cost > NAMES_BUDGET && shown.length > 0) break;
    shown.push(name);
    used += cost;
  }
  const tail = shown.length < unapplied.length ? ` и ещё ${unapplied.length - shown.length}` : '';

  const explained = shown
    .filter((name) => (reasons[name] ?? '').trim().length > 0)
    .map((name) => `${name}: ${reasons[name].trim().slice(0, REASON_LIMIT)}`);

  const head = `миграции не применились: ${shown.join(', ')}${tail}. Схема расходится с кодом`;
  if (explained.length === 0) {
    return `${head}; смотри лог деплоя (строки «[migrate] ✗»)`;
  }
  const silent = shown.length - explained.length;
  const rest = silent > 0 ? `\nОстальные (${silent}) без записи о падении — смотри лог деплоя.` : '';
  return `${head}. Причины:\n${explained.join('\n')}${rest}`;
}
