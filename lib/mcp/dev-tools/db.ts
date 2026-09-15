/**
 * lib/mcp/dev-tools/db.ts
 *
 * Доступность базы для dev-tools MCP-сервера — отдельным модулем, чтобы её
 * можно было проверить тестом: сам сервер при импорте поднимает stdio-цикл
 * и в модульный тест не втаскивается.
 *
 * ЗАЧЕМ ПРОВЕРКА. Раньше в сервере стояло
 * `new Pool({ connectionString: process.env.DATABASE_URL })` без проверки
 * (находка Evo Judge 15.09). `pg` на `undefined` НЕ падает: он молча
 * собирает соединение из PG*-переменных и умолчаний libpq — localhost:5432,
 * база по имени пользователя ОС. Вместо внятного «переменная не задана»
 * brain-инструменты отвечали `ECONNREFUSED ::1:5432`, а на машине с
 * поднятым локальным постгресом — ходили в ЧУЖУЮ базу и отвечали
 * `relation "agent_knowledge" does not exist`. Обе формулировки уводят от
 * настоящей причины: агент, читающий такой ответ, начинает чинить схему.
 *
 * Отсутствие базы — состояние «не могу», и оно обязано называться (§4.0).
 * При этом глушить весь сервер нельзя: инструменты без БД
 * (next_migration_id, sql_rules, check_protected) от неё не зависят и
 * должны работать.
 */
import { Pool } from 'pg';

export const DB_UNAVAILABLE_MESSAGE =
  'DATABASE_URL не задан — brain-инструменты недоступны. ' +
  'Проверь .env.local в корне репозитория (сервер читает его при старте) ' +
  'или переменные окружения процесса. Инструменты без БД работают.';

/**
 * Пул или `null`, если строки подключения нет. `null` — не ошибка, а
 * честное «базы нет»; ошибку выдаёт `requireDb()` тому, кому база нужна.
 */
export function createDbPool(connectionString: string | undefined): Pool | null {
  if (!connectionString) return null;
  return new Pool({ connectionString });
}

/** Пул или внятный отказ. Ошибку ловит JSON-RPC-обёртка и отдаёт вызывающему. */
export function requireDb(dbPool: Pool | null): Pool {
  if (!dbPool) throw new Error(DB_UNAVAILABLE_MESSAGE);
  return dbPool;
}
