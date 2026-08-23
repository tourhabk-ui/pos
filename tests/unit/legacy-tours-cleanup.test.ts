/**
 * Снос демо-строк из мёртвой `tours` — необратимое действие над таблицей,
 * которую платформа не читает.
 *
 * Решение владельца 23.08.2026 по замеру (проба 101): из 17 строк одиннадцать
 * — старые копии туров живого оператора «Камчатская рыбалка», их не трогаем;
 * шесть — демо от 31.03.2026, и именно они внешним ключом держат пятерых
 * бесхозных партнёров от удаления.
 *
 * Разрешение писать в мёртвую таблицу опаснее разрешения читать, поэтому
 * планка выше и сторож строже: удаление обязано идти по НАЗВАННОМУ перечню
 * строк, а не по предикату. Предикат вида «где создано 31 марта» завтра
 * захватит больше, чем задумано: данные меняются, условие остаётся.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEGACY_READ_ALLOWLIST,
  LEGACY_WRITE_ALLOWLIST,
  checkLegacyUsage,
  stripCodeComments,
} from '@/lib/agents/evo/static-checks';

const ROUTE = 'app/api/cron/legacy-tours-cleanup/route.ts';
const SRC = readFileSync(join(process.cwd(), ROUTE), 'utf-8');
const CODE = stripCodeComments(SRC);

describe('разрешение писать в мёртвую таблицу', () => {
  it('живёт в ОТДЕЛЬНОМ списке, не вперемешку с чтением', () => {
    // Иначе запись разрешалась бы молчанием: добавил файл «в список
    // исключений» — и никто не заметил, что исключение теперь про DELETE.
    expect(Object.keys(LEGACY_WRITE_ALLOWLIST)).toContain(ROUTE);
    expect(Object.keys(LEGACY_READ_ALLOWLIST)).not.toContain(ROUTE);
  });

  it('список записи короче списка чтения и назван поимённо', () => {
    expect(Object.keys(LEGACY_WRITE_ALLOWLIST).length).toBeLessThanOrEqual(2);
    expect(LEGACY_WRITE_ALLOWLIST[ROUTE]).toMatch(/23\.08\.2026/);
  });

  it('оба читателя правила знают про запись', () => {
    // Запрет реализован дважды — объективом и регулярками аудита. Список,
    // заведённый в одном, разошёлся бы со вторым в тот же день.
    const audit = readFileSync(
      join(process.cwd(), '.claude/skills/kamchatka/scripts/audit.mjs'), 'utf-8',
    );
    expect(audit).toMatch(/allow_write/);
  });

  it('клеймо снято ровно с этого файла', () => {
    const code = 'const q = `DELETE FROM tours WHERE id = $1`;';
    expect(checkLegacyUsage(ROUTE, code)).toEqual([]);
    expect(checkLegacyUsage('app/api/cron/other/route.ts', 'const q = `SELECT 1 FROM tours`;').length)
      .toBeGreaterThan(0);
  });
});

describe('удаление по перечню, а не по предикату', () => {
  it('строки названы поимённо, с id и заголовком', () => {
    const ids = SRC.match(/id: '[0-9a-f-]{36}'/g) ?? [];
    expect(ids.length).toBe(6);
  });

  it('в DELETE нет условий, кроме id и имени', () => {
    // Никаких «где создано тогда-то» и «где оператор без туров»: такое
    // условие переживёт данные и однажды снесёт лишнее.
    const del = CODE.slice(CODE.indexOf('DELETE FROM tours'));
    const stmt = del.slice(0, del.indexOf('`', 1));
    expect(stmt).toMatch(/WHERE id = \$1 AND name = \$2/);
    expect(stmt).not.toMatch(/created_at|operator_id|NOT EXISTS|LIKE|ILIKE/i);
  });

  it('имя проверяется в самом DELETE, а не только при отборе', () => {
    // Если по этому id окажется другая строка, удаления не будет, и это
    // назовётся отказом, а не снесёт чужое молча.
    expect(CODE).toMatch(/AND name = \$2/);
  });

  it('одиннадцать строк живого оператора не упомянуты вовсе', () => {
    // Их судьба — отдельный разговор. Здесь их не должно быть даже случайно.
    expect(SRC).not.toMatch(/рыболовный тур|Летняя рыбалка|Зимняя рыбалка|Семейный/);
  });
});

describe('тормоза', () => {
  it('по умолчанию НИЧЕГО не удаляет', () => {
    expect(CODE).toMatch(/confirm = body\?\.confirm === true/);
    expect(CODE).toMatch(/dry_run: true/);
  });

  it('каждая строка — в своей транзакции', () => {
    // Миграция откатила бы весь файл на первой упёршейся строке и записалась
    // бы применённой (задача #58). В необратимой операции это недопустимо.
    expect(CODE).toMatch(/BEGIN/);
    expect(CODE).toMatch(/COMMIT/);
    expect(CODE).toMatch(/ROLLBACK/);
    expect(CODE).toMatch(/client\.release\(\)/);
  });

  it('отказ строки называет SQLSTATE и ограничение', () => {
    expect(CODE).toMatch(/e\?\.constraint/);
    expect(CODE).toMatch(/skipped/);
  });

  it('закрыт CRON_SECRET со сравнением за постоянное время', () => {
    expect(CODE).toMatch(/getCronSecret\(request\)/);
    expect(CODE).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
  });
});
