import { Pool, PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';

// ── Чего здесь больше нет ────────────────────────────────────────────────
//
// Модуль нёс одиннадцать админ-инструментов раннего этапа. Ни один не звался
// ниоткуда; перепись 22.08.2026 разобрала их поимённо.
//
//   getPool, closePool     — пул живёт в lib/db-pool.ts, и берут именно его.
//                            Две двери в одну комнату однажды дают два пула.
//   createIndexes          — создавала индексы списком, минуя миграции. Это
//                            прямо запрещено: схему меняют миграцией.
//   cleanupOldData         — удаляла сессии старше 30 дней и логи старше 90,
//                            ГЛУША при этом каждую ошибку пустым catch. Крона
//                            у неё не было, то есть чистка не шла ни разу.
//                            Понадобится — заводить кроном, с отказом вслух.
//   testConnection         — «SELECT NOW() и true/false». Здоровье БД меряет
//                            /api/health/db, и меряет тем же запросом.
//   exportData, importData — выгрузка и загрузка таблицы из белого списка;
//                            потребителя не появилось за всё время.
//   getTableStats, getPerformanceMetrics, getActiveConnections,
//   checkDataIntegrity     — материал для экрана здоровья БД, которого нет.
//                            Заводить экран по четырём непроверенным запросам
//                            (два из них требуют pg_stat_statements) значит
//                            обещать наблюдаемость, а не давать её.
//
// getTableInfo ОСТАЛАСЬ и подключена: она отвечает на вопрос «что в базе на
// самом деле», об который трижды за день спотыкался разбор расхождений схемы
// (GET /api/admin/health/schema-drift).

// Интерфейс для результата запроса
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
  command: string;
}

// Функция для выполнения запросов
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// Функция для выполнения транзакций
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Функция для получения информации о таблицах
export async function getTableInfo(): Promise<QueryResult<{
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}>> {
  return query(`
    SELECT 
      table_name,
      column_name,
      data_type,
      is_nullable
    FROM information_schema.columns 
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
}

// Whitelist of tables allowed for export/import (prevent SQL injection)
const SAFE_TABLES = new Set([
  'activities', 'partners', 'assets', 'tours', 'users',
  'bookings', 'reviews', 'notifications', 'tourist_wishlist',
  'guide_schedule', 'guide_earnings', 'guide_groups',
  'support_tickets', 'audit_logs', 'agent_route_knowledge',
  'eco_points_log', 'user_sessions',
]);

// Validate identifier (table/column name): alphanumeric + underscores only
function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

// Экспорт пула для прямого использования
export { pool };

