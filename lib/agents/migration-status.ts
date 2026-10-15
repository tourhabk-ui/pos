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

import { compareMigrations, sortMigrations } from '@/lib/database/migration-order';

/**
 * Ответ снятых HTTP-дверей ручного наката (`/api/admin/migrations/apply` и
 * `/run-pending`, аудит 15.10, P4-04). Одна строка на обе: две разные
 * формулировки одного правила со временем разошлись бы.
 */
export const MIGRATIONS_DEPLOY_ONLY =
  'Миграции через HTTP не применяются. Их применяет только деплой: start.js перед '
  + 'стартом сервера запускает scripts/migrate-standalone.js, а миграция, упавшая на '
  + 'выкате, повторяется на следующем. Что не применено и почему — '
  + 'GET /api/admin/migrations/status и страница /hub/admin/migrations.';

/**
 * Имена файлов миграций, которых нет в таблице учёта, — в порядке применения.
 *
 * Порядок числовой (`sortMigrations`), не посимвольный: при голом `.sort()`
 * `1000_` вставал раньше `999_`, и список неприменённых читался не в том
 * порядке, в каком их покатит деплой (аудит 15.10, P4-04).
 */
export function findUnappliedMigrations(
  files: readonly string[],
  applied: readonly string[],
): string[] {
  const done = new Set(applied);
  return sortMigrations(
    files
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => !done.has(f)),
  );
}

/** Строка `_migration_failures`: записанная причина падения на деплое. */
export interface MigrationFailure {
  name: string;
  error: string;
  attempts: number;
  /** ISO-время последнего падения; `null` — не записано. */
  last_failed_at: string | null;
}

/** Неприменённая миграция и то, что о ней известно. */
export interface UnappliedMigration {
  name: string;
  /**
   * Записанная причина падения. `null` — записи нет: миграция ещё не
   * запускалась (новый файл до выката) либо раннер остановлен раньше, чем
   * записал причину (таймаут, рестарт контейнера). «Нет записи» не равно
   * «упала без причины» — это незнание, и экран называет его словами.
   */
  error: string | null;
  attempts: number | null;
  last_failed_at: string | null;
}

/** Состояние миграций для экрана админки — только чтение. */
export interface MigrationStatusReport {
  files_total: number;
  applied_total: number;
  unapplied: UnappliedMigration[];
  /**
   * Записи о падении у файлов, которых нет среди неприменённых: файл уже
   * отмечен применённым (уборка записи не прошла) или его нет в каталоге.
   * Сторож `checkFailedMigrations` будит по ним, значит экран обязан их
   * показать — иначе тревога есть, а объяснения нет.
   */
  other_failures: MigrationFailure[];
  /**
   * `false` — `_migration_failures` прочитать не удалось: причины НЕИЗВЕСТНЫ,
   * а не отсутствуют (§4.0). Тогда у всех `unapplied` `error: null`.
   */
  reasons_known: boolean;
}

/**
 * Сводка «что не применено и почему» — каталог против журнала и причин.
 *
 * Заведена вместе со снятием ручного наката через HTTP (аудит 15.10, P4-04):
 * кнопка «Применить миграции» катила файлы, не отмечая их в `_migrations`, и
 * следующий деплой накатывал их второй раз. Применяет только деплой
 * (`start.js` → `scripts/migrate-standalone.js`); экрану осталось чтение.
 *
 * `failures === null` — таблицу причин прочитать не смогли.
 */
export function buildMigrationStatus(
  files: readonly string[],
  applied: readonly string[],
  failures: readonly MigrationFailure[] | null,
): MigrationStatusReport {
  const sqlFiles = files.filter((f) => f.endsWith('.sql'));
  const unappliedNames = findUnappliedMigrations(sqlFiles, applied);
  const byName = new Map((failures ?? []).map((f) => [f.name, f]));
  const pending = new Set(unappliedNames);

  return {
    files_total: sqlFiles.length,
    applied_total: sqlFiles.length - unappliedNames.length,
    unapplied: unappliedNames.map((name) => {
      const f = byName.get(name);
      return {
        name,
        error: f ? f.error : null,
        attempts: f ? f.attempts : null,
        last_failed_at: f ? f.last_failed_at : null,
      };
    }),
    other_failures: (failures ?? [])
      .filter((f) => !pending.has(f.name))
      .sort((a, b) => compareMigrations(a.name, b.name)),
    reasons_known: failures !== null,
  };
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
