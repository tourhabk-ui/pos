/**
 * Перепись мёртвой таблицы `tours` и исключение, которое её разрешает.
 *
 * Повод. Уборка партнёров 22.08 удалила пятерых из десяти; остальные пять
 * упёрлись в `23503 tours_operator_id_fkey` — внешний ключ таблицы, читать
 * которую платформе запрещено (§4). Значит на проде есть строки, которых
 * никто не показывает, но которые держат партнёров от удаления.
 *
 * Исключение из запрета опаснее самого запрета: разрешив читать мёртвую
 * таблицу «для переписи», легко получить чтение мёртвой таблицы вообще.
 * Поэтому сторож держит не только перепись, но и границы разрешения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_READ_ALLOWLIST, checkLegacyUsage, stripCodeComments } from '@/lib/agents/evo/static-checks';

const ROUTE = 'app/api/cron/legacy-tours-census/route.ts';
const SRC = readFileSync(join(process.cwd(), ROUTE), 'utf-8');
/**
 * Запреты проверяются по КОДУ, не по прозе. Шапка переписи цитирует ошибку
 * Postgres целиком («update or delete on table "partners" violates...») —
 * без этой очистки сторож ловил бы собственную цитату и требовал выкинуть
 * из объяснения тот самый факт, ради которого перепись и написана.
 */
const CODE = stripCodeComments(SRC);

describe('разрешение читать мёртвую таблицу', () => {
  it('поимённое и с причиной, а не общим правилом', () => {
    expect(Object.keys(LEGACY_READ_ALLOWLIST)).toContain(ROUTE);
    expect(LEGACY_READ_ALLOWLIST[ROUTE].length).toBeGreaterThan(20);
  });

  it('список короткий: разрешение — исключение, а не режим', () => {
    // Растущий список исключений означает, что запрет перестал работать.
    // Порог не «красивое число», а сигнал остановиться и спросить владельца.
    expect(Object.keys(LEGACY_READ_ALLOWLIST).length).toBeLessThanOrEqual(3);
  });

  it('список один на обоих читателей правила', () => {
    // Запрет «не читать tours» реализован ДВАЖДЫ: объективом эволюции и
    // регулярками пре-коммитного аудита. Разрешение, заведённое в одном,
    // разошлось бы со вторым в тот же день — так уже расходились две
    // проверки имени оператора и начисление комиссии на двух вебхуках.
    const audit = readFileSync(
      join(process.cwd(), '.claude/skills/kamchatka/scripts/audit.mjs'), 'utf-8',
    );
    expect(audit, 'аудит обязан читать общий список, а не держать свой')
      .toMatch(/legacy-read-allowlist\.json/);
    // Обе проверки устаревших таблиц ходят через общий сбор исключений.
    expect((audit.match(/legacyExclude\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('разрешение снимает клеймо ровно с этого файла', () => {
    const code = 'const q = `SELECT 1 FROM tours`;';
    expect(checkLegacyUsage(ROUTE, code)).toEqual([]);
    // Соседний роут тем же кодом — по-прежнему находка.
    expect(checkLegacyUsage('app/api/cron/other/route.ts', code).length).toBeGreaterThan(0);
  });

  it('разрешено ЧИТАТЬ, не писать', () => {
    // Пребывание в списке обусловлено безвредностью. Запись в мёртвую
    // таблицу — уже не перепись, и файл обязан вылететь из разрешения.
    expect(CODE).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|DROP)\b/i);
  });
});

describe('перепись', () => {
  it('закрыта CRON_SECRET со сравнением за постоянное время', () => {
    expect(SRC).toMatch(/getCronSecret\(request\)/);
    expect(SRC).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });

  it('набор колонок берёт из живой базы, а не из мёртвого файла схемы', () => {
    // `tours` объявлена ТОЛЬКО в lib/database/schema.sql, ни одной миграции с
    // её CREATE TABLE нет. Спрашивать состав у реестра, который CLAUDE.md не
    // признаёт источником истины, — спрашивать у того, кто не знает (#69).
    expect(SRC).toMatch(/information_schema\.columns/);
    expect(SRC).not.toMatch(/lib\/database\/schema\.sql['"]/);
  });

  it('имена колонок в проекцию попадают только через зашитый перечень', () => {
    // Имена приходят из системного каталога, но в SQL уходят лишь те, что
    // есть в WANTED_COLUMNS: подстановки извне нет по построению.
    expect(SRC).toMatch(/WANTED_COLUMNS/);
    expect(SRC).toMatch(/WANTED_COLUMNS\.filter\(\(c\) => present\.has\(c\)\)/);
  });

  it('третий исход: «таблицы нет» — это ответ, а не ноль строк', () => {
    expect(SRC).toMatch(/table_present: false/);
    expect(SRC).toMatch(/columns\.length === 0/);
  });

  it('отказ называет SQLSTATE, а не превращается в «данных нет»', () => {
    expect(SRC).toMatch(/sqlstate/);
    expect(SRC).toMatch(/console\.error/);
    expect(SRC).toMatch(/ok: false/);
  });

  it('совпадение имени не называется дублем', () => {
    // Одинаковое название не доказывает, что это тот же тур. Поле обязано
    // говорить ровно то, что проверено.
    expect(SRC).toMatch(/same_title_in_operator_tours/);
    expect(SRC).not.toMatch(/duplicates_in_operator_tours/);
  });
});
