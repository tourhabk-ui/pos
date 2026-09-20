// @vitest-environment node
/**
 * duplicate key на UPDATE — это отказ, а не идемпотентность.
 *
 * ── Что стоило шага миграции (19.09) ──────────────────────────────────────
 *
 * У `ai_route_images` колонка `route_id` уникальна. Миграция 988 переносила
 * снимок каньона на запись «Крылья Гамулов», слот которой был занят, и
 * `UPDATE` получил 23505 duplicate key.
 *
 * Накатчик решал по ТЕКСТУ ошибки и ничего не знал о виде выражения. Он
 * прочитал 23505 как «уже существует», записал в лог выката `[skip-exists]`,
 * применил остальные выражения файла и пометил файл применённым. Повторно
 * такой файл не пойдёт никогда: накатчик помнит имена применённых файлов, а
 * не их исход.
 *
 * Дальше по цепочке всё отработало честно и именно это спасло кадр: скрытие
 * дубля в 988 было условным и не сработало, сборка пакетов карты отказалась
 * заливать. Но исходная потеря была НЕВИДИМОЙ — в логе стояло слово «skip»,
 * то есть «не смог» в чистом виде выдавалось за «хорошо» (§4.0). Понадобились
 * две миграции (990, 991) и отдельная проба, чтобы восстановить, что именно
 * пропало.
 *
 * ── Где проходит граница ──────────────────────────────────────────────────
 *
 * Для INSERT и CREATE duplicate key значит «уже лежит» — пропуск там верен,
 * ради него механизм и заводился (находка 14.08, см. migrate-no-swallow).
 * Для UPDATE и DELETE ничего не сделано, и молчать нельзя.
 *
 * Падение безопасно: файл не помечается применённым, попадает в
 * `_migration_failures` со счётчиком попыток и идёт заново на следующем
 * выкате, а старт сервера от отказа миграции не зависит (start.js).
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const { isAlreadyExistsError, isCreatingStatement, applyTransactionalFile } =
  requireCjs('../../scripts/migrate-standalone.js') as {
    isAlreadyExistsError: (msg: string, stmt?: string) => boolean;
    isCreatingStatement: (stmt: string) => boolean;
    applyTransactionalFile: (
      client: { query: (sql: string, vals?: unknown[]) => Promise<unknown> },
      sql: string,
      log?: (l: string) => void,
    ) => Promise<{ statements: number; skippedStatements: number }>;
  };

/** Дословный текст, который Postgres даёт на 23505. */
const DUP = 'duplicate key value violates unique constraint "ai_route_images_route_id_key"';

describe('duplicate key судится по виду выражения', () => {
  it('на UPDATE — отказ: ничего не сделано, и это надо видеть', () => {
    expect(isAlreadyExistsError(DUP, "UPDATE ai_route_images SET route_id = '...' WHERE id = 1")).toBe(false);
  });

  it('на DELETE — тоже отказ', () => {
    expect(isAlreadyExistsError(DUP, 'DELETE FROM ai_route_images WHERE route_id = $1')).toBe(false);
  });

  it('на INSERT — идемпотентность, ради неё механизм и заведён', () => {
    expect(isAlreadyExistsError(DUP, "INSERT INTO places (id, name) VALUES ('x', 'y')")).toBe(true);
  });

  it('на CREATE — идемпотентность', () => {
    expect(isAlreadyExistsError('relation "places" already exists', 'CREATE TABLE places (id text)')).toBe(true);
  });

  it('«уже существует» вида не спрашивает — это DDL по существу', () => {
    expect(isAlreadyExistsError('relation "x" already exists', 'UPDATE t SET a = 1')).toBe(true);
    expect(isAlreadyExistsError('column "c" of relation "t" already exists', 'ALTER TABLE t ADD COLUMN c int')).toBe(true);
  });

  it('чужая ошибка не пропускается ни при каком виде', () => {
    expect(isAlreadyExistsError('null value in column "name" violates not-null constraint', 'INSERT INTO t VALUES (1)')).toBe(false);
    expect(isAlreadyExistsError('', 'INSERT INTO t VALUES (1)')).toBe(false);
  });
});

describe('вид выражения распознаётся в том виде, в каком выражения тут пишут', () => {
  it('ведущий комментарий не мешает: над каждым вторым выражением тут абзац', () => {
    expect(isCreatingStatement('-- объяснение на две строки\n-- и ещё одна\nINSERT INTO t VALUES (1)')).toBe(true);
    expect(isCreatingStatement('/* блок */\nUPDATE t SET a = 1')).toBe(false);
  });

  it('WITH разбирается на шаг вперёд', () => {
    expect(isCreatingStatement('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(true);
    expect(isCreatingStatement('WITH x AS (SELECT 1) UPDATE t SET a = 1 FROM x')).toBe(false);
  });

  it('незнакомая форма считается НЕ создающей, то есть громкой', () => {
    // Умолчание выбрано в сторону шума: лишний раз показать отказ дешевле,
    // чем один раз выдать «не смог» за «уже сделано».
    expect(isCreatingStatement('DO $$ BEGIN PERFORM 1; END $$')).toBe(false);
    expect(isCreatingStatement('MERGE INTO t USING s ON (1=1)')).toBe(false);
  });
});

describe('живой прогон файла: случай 988 воспроизведён', () => {
  /** Клиент, у которого ровно одно выражение падает на 23505. */
  function clientFailingOn(needle: string) {
    const seen: string[] = [];
    return {
      seen,
      query: vi.fn(async (sql: string) => {
        seen.push(sql);
        if (sql.includes(needle)) {
          throw Object.assign(new Error(DUP), { code: '23505' });
        }
        return { rows: [] };
      }),
    };
  }

  it('UPDATE со столкновением роняет файл, а не пропускается молча', async () => {
    const c = clientFailingOn('SET route_id');
    await expect(applyTransactionalFile(c, `
      BEGIN;
      UPDATE ai_route_images SET route_id = 'a' WHERE route_id = 'b';
      UPDATE places SET is_visible = FALSE WHERE id = 'c';
      COMMIT;
    `)).rejects.toThrow(/duplicate key/);

    // И второе выражение не применилось: файл не «прошёл частично», он не прошёл.
    expect(c.seen.some(s => s.includes('is_visible'))).toBe(false);
  });

  it('INSERT со столкновением по-прежнему пропускает только себя', async () => {
    const c = clientFailingOn('INSERT INTO places');
    const res = await applyTransactionalFile(c, `
      BEGIN;
      INSERT INTO places (id) VALUES ('x');
      UPDATE places SET is_visible = FALSE WHERE id = 'c';
      COMMIT;
    `);
    expect(res.skippedStatements).toBe(1);
    expect(c.seen.some(s => s.includes('is_visible'))).toBe(true);
  });
});
