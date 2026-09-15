/**
 * tests/unit/mcp-dev-tools-db-env.test.ts
 *
 * MCP dev-tools: «базы нет» называется вслух, а не подменяется чужой.
 *
 * Находка Evo Judge 15.09: `lib/mcp/dev-tools/server.ts` создавал пул как
 * `new Pool({ connectionString: process.env.DATABASE_URL })` без проверки.
 * `pg` на `undefined` не падает — он собирает соединение из PG*-переменных и
 * умолчаний libpq (localhost:5432, база по имени пользователя ОС). Отсюда
 * два неверных ответа вместо одного верного: `ECONNREFUSED ::1:5432` там,
 * где постгреса нет, и `relation "agent_knowledge" does not exist` там, где
 * он есть, но чужой. Оба уводят от причины — агент идёт чинить схему вместо
 * того, чтобы задать переменную.
 *
 * Отсутствие базы — исход «не могу» (§4.0). При этом инструменты, которым
 * база не нужна (next_migration_id, sql_rules, check_protected), обязаны
 * работать: отсутствие БД — не повод глушить весь сервер.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDbPool, requireDb, DB_UNAVAILABLE_MESSAGE } from '@/lib/mcp/dev-tools/db';

const SRC = readFileSync('lib/mcp/dev-tools/server.ts', 'utf8');

describe('createDbPool — пул только при заданной строке подключения', () => {
  it('нет DATABASE_URL — пула нет вовсе, а не пул на умолчаниях libpq', () => {
    expect(createDbPool(undefined)).toBeNull();
    expect(createDbPool('')).toBeNull();
  });

  it('строка задана — пул создаётся', async () => {
    const pool = createDbPool('postgres://user:pass@127.0.0.1:5432/nonexistent');
    expect(pool).not.toBeNull();
    await pool!.end(); // соединение не открывалось — закрываем пустой пул
  });
});

describe('requireDb — отказ называет причину', () => {
  it('без пула бросает сообщение про DATABASE_URL, а не сетевую ошибку', () => {
    expect(() => requireDb(null)).toThrow(/DATABASE_URL не задан/);
    expect(DB_UNAVAILABLE_MESSAGE, 'сообщение должно вести к .env.local').toContain('.env.local');
    expect(DB_UNAVAILABLE_MESSAGE, 'и говорить, что не всё сломано').toContain('Инструменты без БД работают');
  });

  it('пул есть — возвращается он же', () => {
    const fake = { query: () => {} } as unknown as Parameters<typeof requireDb>[0];
    expect(requireDb(fake)).toBe(fake);
  });
});

describe('сервер держит связку, а не половину', () => {
  it('своего new Pool в сервере не осталось — иначе проверку обходят мимо', () => {
    expect(SRC, 'пул поднимается только через createDbPool').not.toMatch(/new Pool\(/);
    expect(SRC).toContain('createDbPool(process.env.DATABASE_URL)');
  });

  it('каждый brain-запрос идёт через db(), а не через пул напрямую', () => {
    expect(SRC).not.toMatch(/dbPool\.query\(/);
    const queries = SRC.match(/db\(\)\.query\(/g) ?? [];
    expect(queries.length, 'brain-инструментов пять, запросов у них семь').toBeGreaterThanOrEqual(7);
  });

  it('инструменты без БД к пулу не обращаются', () => {
    for (const fn of ['function nextMigrationId', 'function sqlRules', 'function checkProtected']) {
      const at = SRC.indexOf(fn);
      expect(at, `${fn} не найдена`).toBeGreaterThan(-1);
      const body = SRC.slice(at, SRC.indexOf('\n}', at));
      expect(body, `${fn} не должна зависеть от базы`).not.toContain('db()');
    }
  });

  it('отказ доходит до вызывающего ответом JSON-RPC, а не молчанием', () => {
    // tools/call обёрнут try/catch с respondError(-32603, message) — именно
    // там сообщение requireDb становится видимым для агента.
    expect(SRC).toMatch(/catch \(err\) \{\s*respondError\(-32603, \(err as Error\)\.message\)/);
  });
});
