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

/** Человекочитаемая строка для Telegram. */
export function formatUnappliedMigrations(unapplied: readonly string[]): string {
  const head = unapplied.slice(0, 5).join(', ');
  const tail = unapplied.length > 5 ? ` и ещё ${unapplied.length - 5}` : '';
  return `миграции не применились: ${head}${tail}. Схема расходится с кодом; смотри лог деплоя (строки «[migrate] ✗»)`;
}
