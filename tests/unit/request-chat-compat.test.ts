/**
 * Прежние имена переписки по заявке (1349) — только представления
 * совместимости (1350).
 *
 * Миграции идут только вперёд: откат кода оставил бы новые имена таблиц, и
 * прежний код упал бы на 42P01 — статус ЛЮБОЙ заявки читает переписку. То же
 * в окне выката, пока работает прежняя сборка. Поэтому `stay_request_messages`
 * и `stay_chat_waits` остаются изменяемыми представлениями над
 * `request_messages` и `request_chat_waits`.
 *
 * Держит связку:
 *  - представления объявлены в 1350 и видят только заявки на жильё (код 1349
 *    о лидах не знает);
 *  - новый код к ним не обращается: представление, поставленное «на время
 *    выката», не должно стать опорой — иначе его нельзя будет снять.
 * Что INSERT, UPDATE и SELECT прежнего кода через них работают, судит
 * настоящая база: tests/integration/request-chat.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const OLD_NAMES = /\b(stay_request_messages|stay_chat_waits)\b/;

/** Код без комментариев: пояснение «было так» — не обращение к таблице. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => {
      const at = l.indexOf('//');
      return at === -1 ? l : l.slice(0, at);
    })
    .join('\n');
}

describe('прежние имена переписки — представления совместимости', () => {
  it('1350 объявляет оба представления, и они видят только заявки на жильё', () => {
    const sql = readFileSync(join(ROOT, 'migrations/1350_request_chat_all.sql'), 'utf8');
    for (const [view, table] of [['stay_request_messages', 'request_messages'], ['stay_chat_waits', 'request_chat_waits']]) {
      const m = new RegExp(`CREATE OR REPLACE VIEW ${view} AS\\s+SELECT [^;]+FROM ${table}\\s+WHERE stay_request_id IS NOT NULL;`).exec(sql);
      expect(m, `${view}: представление над ${table} только по заявкам на жильё`).not.toBeNull();
    }
  });

  it('код платформы прежние имена не читает и не пишет', () => {
    const files = execSync("git ls-files 'lib/**/*.ts' 'app/**/*.ts' 'app/**/*.tsx' 'components/**/*.tsx' 'scripts/**/*.ts' 'scripts/**/*.js'", {
      encoding: 'utf8', cwd: ROOT,
    }).split('\n').filter(Boolean);
    // Ноль файлов при ненулевом репозитории — отказ разбора, а не «чисто» (§4.0).
    expect(files.length).toBeGreaterThan(500);
    const users = files.filter((f) => OLD_NAMES.test(codeOnly(readFileSync(join(ROOT, f), 'utf8'))));
    expect(users, 'обращение к прежнему имени — пишите в request_messages / request_chat_waits').toEqual([]);
  });
});
