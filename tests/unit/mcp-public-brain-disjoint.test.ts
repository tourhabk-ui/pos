// @vitest-environment node
/**
 * Публичный MCP и мозг разработчика не пересекаются (внешний аудит 07.09).
 *
 * У нас два MCP-сервера с очень разной ценой ошибки:
 *
 *   `lib/mcp/public-tools.ts` — витрина. Авторизации нет по решению (манифест
 *   так и говорит: `"authentication": "none"`), запись — только заявка:
 *   `create_lead` и `create_booking_request`. Оплаты там нет.
 *
 *   `lib/mcp/dev-tools/server.ts` — мозг: `brain_upsert` пишет в знание
 *   платформы, `check_protected` рассказывает про §7, `sql_rules` — про схему.
 *
 * Сегодня они разделены, и разделены НИЧЕМ, кроме того, что никто не написал
 * лишний import. Аудит указал на это точно: одна строчка `import` из
 * dev-tools в публичный роут — и анонимный вызов начинает писать в
 * `agent_knowledge`. Такая ошибка не выглядит ошибкой на ревью: импорт как
 * импорт, тесты зелёные, поведение меняется молча.
 *
 * Поэтому свойство закрепляется тестом, а не дисциплиной. Проверяются оба
 * конца сразу: имена не пересекаются И публичный путь физически не тянет
 * модуль мозга. Одного первого мало — инструмент мозга можно занести под
 * другим именем; одного второго мало — вызов возможен не только импортом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Имена инструментов, объявленные в файле, — по `name: '...'`. */
function toolNames(src: string): string[] {
  return [...src.matchAll(/^\s*name:\s*'([a-z0-9_]+)'/gim)].map((m) => m[1]);
}

const PUBLIC_SRC = readFileSync(join(ROOT, 'lib/mcp/public-tools.ts'), 'utf-8');
const BRAIN_SRC = readFileSync(join(ROOT, 'lib/mcp/dev-tools/server.ts'), 'utf-8');

/** Все файлы под app/api/mcp — публичная поверхность. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('имена инструментов не пересекаются', () => {
  it('оба списка непусты — иначе сторож охраняет пустоту', () => {
    expect(toolNames(PUBLIC_SRC).length).toBeGreaterThan(0);
    expect(toolNames(BRAIN_SRC).length).toBeGreaterThan(0);
  });

  it('пересечение пустое', () => {
    const pub = new Set(toolNames(PUBLIC_SRC));
    const overlap = toolNames(BRAIN_SRC).filter((n) => pub.has(n));
    expect(
      overlap,
      `инструмент мозга оказался в публичном списке: ${overlap.join(', ')}`,
    ).toEqual([]);
  });

  it('инструменты мозга не названы в публичном файле вовсе', () => {
    // Не только как объявление, но и упоминанием: публичный список не должен
    // знать про них ни строкой — ни в описании, ни в маршрутизации вызова.
    for (const n of toolNames(BRAIN_SRC)) {
      expect(PUBLIC_SRC, `публичный файл упоминает инструмент мозга ${n}`).not.toContain(`'${n}'`);
    }
  });
});

describe('публичный путь не тянет модуль мозга', () => {
  const publicFiles = walk(join(ROOT, 'app/api/mcp'));

  it('файлы публичного MCP найдены', () => {
    expect(publicFiles.length).toBeGreaterThan(0);
  });

  for (const f of publicFiles) {
    it(`${f.replace(ROOT + '/', '')}: нет импорта dev-tools`, () => {
      const src = readFileSync(f, 'utf-8');
      expect(
        src,
        'импорт мозга в публичный роут открывает анонимную запись в знание платформы',
      ).not.toMatch(/from\s+['"][^'"]*mcp\/dev-tools/);
    });
  }
});

describe('запись публичного MCP остаётся заявкой, а не действием', () => {
  /**
   * Отдельно от пересечения имён: список публичных инструментов на запись
   * заморожен. Добавить туда что-то — решение владельца, а не следствие
   * удобной правки; расширение молчком и есть тот случай, ради которого
   * весь этот файл написан.
   */
  it('на запись — только заявка на лид и заявка на бронь', () => {
    const write = toolNames(PUBLIC_SRC).filter((n) => /^create_|^update_|^delete_|^set_/.test(n));
    expect(write.sort()).toEqual(['create_booking_request', 'create_lead']);
  });

  it('оплаты в публичных инструментах нет', () => {
    for (const forbidden of ['payment', 'payout', 'charge', 'refund']) {
      expect(PUBLIC_SRC.toLowerCase(), `публичный MCP упоминает ${forbidden}`).not.toContain(`'${forbidden}`);
    }
  });
});
