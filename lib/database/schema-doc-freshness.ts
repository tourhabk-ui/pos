/**
 * lib/database/schema-doc-freshness.ts
 *
 * Свежесть справочника `docs/DB_SCHEMA.md` — одно правило на производителя
 * (job `.github/workflows/db-schema-doc.yml`) и на сторожа
 * (`tests/unit/db-schema-doc.test.ts`).
 *
 * ── Почему справочник больше не снимают в PR (аудит 15.10, AR-schema-doc) ──
 *
 * Справочник — общий генерируемый файл. Пока сторож требовал перегенерации
 * в каждом PR со схемной миграцией, две сессии перегенерировали его каждая в
 * своей ветке, и 15.10 PR #2511 встал в конфликт с main только из-за него.
 * На PR с конфликтом GitHub не запускает проверок вовсе — около 25 минут
 * простоя на файле, который никто не правил руками. Общее состояние,
 * которое пишет каждая ветка, при агентном числе веток — источник очереди,
 * а не порядка.
 *
 * Теперь справочник снимает job после влития миграций в main, а ветке
 * разрешено отставать на свои схемные миграции: их в main ещё нет, и снимок
 * с них был бы снимком будущего, которое может и не наступить.
 *
 * ── Почему правило здесь, а не в тесте ────────────────────────────────────
 *
 * Производитель решает «снимать или нет» тем же предикатом, которым сторож
 * решает «отстал или нет». Два предиката разошлись бы: job молчал бы, когда
 * сторож считает справочник отставшим, и наоборот.
 */
import { compareMigrations, isAfterBaseline, sortMigrations } from './migration-order';

/**
 * Меняет ли миграция СХЕМУ. Справочник снят со схемы, и миграция, которая
 * только пишет строки, устареть его не может.
 *
 * Уточнение 11.09.2026 (миграция 952: партнёр и два тура, ни одной
 * DDL-инструкции). Предикат намеренно ГРУБЫЙ и закрывается в сторону
 * «схема»: любое из слов в любом месте файла — включая тело `DO $$ ...
 * EXECUTE`, где DDL собирается строкой, — считается изменением схемы.
 * Ошибиться можно только в одну сторону: лишний съём стоит минуты раннера,
 * пропущенный — справочника, по которому пишут SQL против несуществующей
 * колонки.
 */
export const SCHEMA_DDL = /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b|\bCOMMENT\s+ON\b/i;

/**
 * `null` — файл не прочитался. Мы НЕ ЗНАЕМ, что в нём, и «не знаю» здесь
 * значит «схемная»: молчаливое «данные» пропустило бы правку схемы (§4.0).
 */
export function changesSchema(sql: string | null): boolean {
  if (sql === null) return true;
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');
  return SCHEMA_DDL.test(code);
}

/** Подпись генератора `scripts/gen-db-schema.ts` в шапке справочника. */
const STAMP = /Последняя миграция в снимке: `([^`]+)`/;

/** Имя миграции, с которой снят справочник. Нет подписи — `null`, не «пусто». */
export function snapshotMigration(doc: string): string | null {
  const m = STAMP.exec(doc);
  return m ? m[1] : null;
}

/**
 * Схемные миграции, которых в снимке ещё нет, — в порядке применения.
 *
 * Положение считается по ПОРЯДКУ (`compareMigrations`), а не по индексу
 * файла в каталоге: снимок мог быть сделан с миграции, которую потом
 * перенумеровали (столкновение номеров, 1260 → 1263 у #2507), и её имени в
 * каталоге уже нет. Порядок от этого не теряется.
 */
export function schemaLag(
  files: readonly string[],
  snapshot: string,
  isSchema: (file: string) => boolean,
): string[] {
  return sortMigrations(files).filter((f) => compareMigrations(f, snapshot) > 0 && isSchema(f));
}

export type Freshness =
  /** Ни одной схемной миграции новее снимка. */
  | { state: 'fresh'; snapshot: string }
  /**
   * Снимок отстал. `missing` — подписанной миграции нет в каталоге: шапка
   * называет файл, которого нет, и это тоже повод снять заново.
   */
  | { state: 'stale'; snapshot: string; lag: string[]; missing: boolean }
  /** Судить не по чему: справочника нет или в нём нет подписи. */
  | { state: 'unknown'; reason: string };

/**
 * Три исхода, не два (§4.0). Что делать с «не знаю», решает вызывающий:
 * производитель снимает справочник заново (это и есть лекарство), сторож
 * краснеет (шапка сломана — справочнику нельзя верить).
 */
export function judgeFreshness(
  doc: string | null,
  files: readonly string[],
  isSchema: (file: string) => boolean,
): Freshness {
  if (doc === null) return { state: 'unknown', reason: 'docs/DB_SCHEMA.md не прочитан' };
  const snapshot = snapshotMigration(doc);
  if (snapshot === null) {
    return { state: 'unknown', reason: 'в шапке docs/DB_SCHEMA.md нет строки «Последняя миграция в снимке»' };
  }
  const lag = schemaLag(files, snapshot, isSchema);
  const missing = !files.includes(snapshot);
  if (lag.length === 0 && !missing) return { state: 'fresh', snapshot };
  return { state: 'stale', snapshot, lag, missing };
}

/** Минимум клиента `pg`, нужный для сброса отметок. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * Снять в `_migrations` отметки миграций новее baseline — после
 * `scripts/bootstrap-from-baseline.js`, который помечает применёнными ВСЕ
 * файлы каталога. Тогда штатный раннер (`npm run migrate`) применит их тем
 * же путём, что `start.js` на выкате.
 *
 * Ноль снятых — отказ, а не успех (§4.0): если bootstrap не отработал или
 * граница не та, `npm run migrate` не применит ничего, а генератор подпишет
 * снимок голого baseline именем последней миграции. Снятые отметки обязаны
 * совпасть с файлами каталога новее границы — расхождение называется по
 * именам.
 */
export async function resetAfterBaseline(
  db: Queryable,
  files: readonly string[],
  firstAfterBaseline: number,
): Promise<string[]> {
  const expected = files.filter((f) => isAfterBaseline(f, firstAfterBaseline));
  if (expected.length === 0) {
    throw new Error(
      `в migrations/ нет ни одного файла с номером от ${firstAfterBaseline} — граница baseline не та или каталог пуст`,
    );
  }
  const applied = (await db.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name);
  const toReset = applied.filter((n) => isAfterBaseline(n, firstAfterBaseline));
  const notMarked = expected.filter((f) => !toReset.includes(f));
  if (notMarked.length > 0) {
    throw new Error(
      `bootstrap не пометил ${notMarked.length} миграций новее baseline (первые: ${notMarked.slice(0, 5).join(', ')}) — база собрана не из baseline`,
    );
  }
  const deleted = (
    await db.query<{ name: string }>(
      'DELETE FROM _migrations WHERE name = ANY($1::text[]) RETURNING name',
      [toReset],
    )
  ).rows.map((r) => r.name);
  if (deleted.length !== toReset.length) {
    throw new Error(`снято ${deleted.length} отметок из ${toReset.length} — часть строк _migrations не нашлась`);
  }
  return sortMigrations(deleted);
}
