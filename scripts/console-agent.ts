#!/usr/bin/env npx tsx
/**
 * scripts/console-agent.ts
 *
 * Интерактивный консольный агент — claude-sonnet-4-6 + инструменты платформы.
 *
 * Запуск:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/console-agent.ts
 *
 * Или через .env.local:
 *   npx tsx -r dotenv/config scripts/console-agent.ts dotenv_config_path=.env.local
 *
 * Инструменты агента:
 *   sql         — выполнить произвольный SELECT-запрос к БД
 *   bookings    — статистика бронирований
 *   operators   — список операторов
 *   tours       — туры на маршрутплейсе
 *   places      — поиск точек/локаций
 *   routes      — маршруты Камчатки
 *   leads       — статистика лидов
 */

import Anthropic from '@anthropic-ai/sdk';
import { Pool } from 'pg';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ── DB pool ──────────────────────────────────────────────────────────────────

function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const useSSL = process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production';
  return new Pool({
    connectionString: url,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 3,
    connectionTimeoutMillis: 5000,
  });
}

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) _pool = getPool();
  return _pool;
}

async function runQuery(sql: string, params: unknown[] = []): Promise<unknown[]> {
  // Только SELECT и WITH-запросы разрешены
  const clean = sql.trim().toUpperCase();
  if (!clean.startsWith('SELECT') && !clean.startsWith('WITH') && !clean.startsWith('EXPLAIN')) {
    throw new Error('Только SELECT / WITH / EXPLAIN запросы разрешены');
  }
  const { rows } = await pool().query(sql, params);
  return rows;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'sql',
    description: 'Выполнить SELECT-запрос к PostgreSQL базе данных платформы tourhab.ru. Только чтение — INSERT/UPDATE/DELETE запрещены.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'SQL SELECT-запрос' },
        limit: { type: 'number', description: 'Максимум строк (по умолчанию 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bookings',
    description: 'Статистика бронирований: общее число, по статусам, по операторам, доход.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'За последние N дней (по умолчанию 30)' },
        operator_id: { type: 'string', description: 'UUID оператора (необязательно)' },
      },
    },
  },
  {
    name: 'operators',
    description: 'Список операторов платформы с их статистикой.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Фильтр по статусу: approved, pending, rejected' },
      },
    },
  },
  {
    name: 'tours',
    description: 'Туры в маркетплейсе: названия, цены, операторы.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Поиск по названию' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'places',
    description: 'Поиск географических точек/локаций Камчатки.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Название или тип (volcano, lake, hot_spring...)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'leads',
    description: 'Статистика лидов и заявок.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'За последние N дней (по умолчанию 30)' },
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {

      case 'sql': {
        const sql = String(input.query ?? '');
        const lim = Number(input.limit ?? 20);
        const q = sql.match(/\bLIMIT\b/i) ? sql : `${sql.trimEnd().replace(/;$/, '')} LIMIT ${lim}`;
        const rows = await runQuery(q);
        if (!rows.length) return 'Нет данных';
        return JSON.stringify(rows, null, 2);
      }

      case 'bookings': {
        const days = Number(input.days ?? 30);
        const opFilter = input.operator_id ? `AND ot.operator_id = '${input.operator_id}'` : '';
        const rows = await runQuery(`
          SELECT
            COUNT(*)                                      AS total,
            COUNT(*) FILTER (WHERE ob.booking_status = 'confirmed')      AS confirmed,
            COUNT(*) FILTER (WHERE ob.booking_status = 'cancelled')      AS cancelled,
            COUNT(*) FILTER (WHERE ob.booking_status = 'new')            AS pending,
            COUNT(*) FILTER (WHERE ob.booking_status = 'pending_payment') AS awaiting_payment,
            COALESCE(SUM(ob.final_price) FILTER (WHERE ob.payment_status = 'paid'), 0) AS revenue_paid,
            COALESCE(SUM(ob.final_price), 0) AS revenue_total
          FROM operator_bookings ob
          JOIN operator_tours ot ON ot.id = ob.operator_tour_id
          WHERE ob.created_at > NOW() - INTERVAL '${days} days'
            AND ob.deleted_at IS NULL
            ${opFilter}
        `);
        return JSON.stringify(rows[0], null, 2);
      }

      case 'operators': {
        const statusFilter = input.status ? `WHERE p.profile_status = '${input.status}'` : '';
        const rows = await runQuery(`
          SELECT p.id, COALESCE(p.company_name, p.name) AS name,
                 p.profile_status, p.onboarding_completed,
                 COUNT(ot.id) AS tours_count
          FROM partners p
          LEFT JOIN operator_tours ot ON ot.operator_id = p.id AND ot.deleted_at IS NULL
          ${statusFilter}
          GROUP BY p.id, p.company_name, p.name, p.profile_status, p.onboarding_completed
          ORDER BY p.created_at DESC
          LIMIT 30
        `);
        return JSON.stringify(rows, null, 2);
      }

      case 'tours': {
        const lim = Number(input.limit ?? 20);
        const search = input.search ? `AND ot.title ILIKE '%${String(input.search).replace(/'/g, "''")}%'` : '';
        const rows = await runQuery(`
          SELECT ot.id, ot.title, ot.base_price, ot.duration_days,
                 ot.activity_type, ot.difficulty_level, ot.is_active,
                 COALESCE(p.company_name, p.name) AS operator
          FROM operator_tours ot
          JOIN partners p ON p.id = ot.operator_id
          WHERE ot.deleted_at IS NULL ${search}
          ORDER BY ot.created_at DESC
          LIMIT ${lim}
        `);
        return JSON.stringify(rows, null, 2);
      }

      case 'places': {
        const lim = Number(input.limit ?? 20);
        const search = input.search
          ? `AND (pl.name ILIKE '%${String(input.search).replace(/'/g, "''")}%' OR pl.location_type ILIKE '%${String(input.search).replace(/'/g, "''")}%')`
          : '';
        const rows = await runQuery(`
          SELECT pl.id, pl.name, pl.location_type, pl.lat, pl.lng,
                 LEFT(pl.description, 120) AS description_preview
          FROM places pl
          WHERE 1=1 ${search}
          ORDER BY pl.name
          LIMIT ${lim}
        `);
        return JSON.stringify(rows, null, 2);
      }

      case 'leads': {
        const days = Number(input.days ?? 30);
        const rows = await runQuery(`
          SELECT
            COUNT(*)                                            AS total,
            COUNT(*) FILTER (WHERE status = 'new')             AS new,
            COUNT(*) FILTER (WHERE status = 'qualified')       AS qualified,
            COUNT(*) FILTER (WHERE status = 'converted')       AS converted,
            COUNT(*) FILTER (WHERE status = 'lost')            AS lost
          FROM leads
          WHERE created_at > NOW() - INTERVAL '${days} days'
        `);
        return JSON.stringify(rows[0], null, 2);
      }

      default:
        return `Неизвестный инструмент: ${name}`;
    }
  } catch (err) {
    return `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────────

async function runAgent(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY не задан. Добавь в .env.local или передай как переменную окружения.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const rl = readline.createInterface({ input, output });

  const SYSTEM = `Ты — операционный ИИ-агент туристической платформы tourhab.ru (Камчатка).
У тебя есть прямой доступ к базе данных через инструменты. Отвечай кратко и по делу.
Если нужно получить данные — вызывай инструменты, не придумывай.
Дата: ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}.`;

  const history: Anthropic.MessageParam[] = [];

  console.log('\nАгент tourhab.ru готов. Введи вопрос или команду. Для выхода — Ctrl+C или "выход".\n');

  while (true) {
    const userInput = await rl.question('Вы: ').catch(() => 'выход');

    if (!userInput.trim() || ['выход', 'exit', 'quit'].includes(userInput.trim().toLowerCase())) {
      console.log('\nДо свидания.');
      break;
    }

    history.push({ role: 'user', content: userInput });

    // Agent loop — handles multi-step tool use
    let iterations = 0;
    while (iterations < 8) {
      iterations++;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM,
        tools: TOOLS,
        messages: history,
      });

      // Collect text and tool_use blocks
      const textBlocks = response.content.filter(b => b.type === 'text');
      const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];

      // Print any text
      for (const b of textBlocks) {
        if (b.type === 'text' && b.text) {
          process.stdout.write(`\nАгент: ${b.text}\n`);
        }
      }

      // Done — no tool calls
      if (response.stop_reason === 'end_turn' || toolBlocks.length === 0) {
        history.push({ role: 'assistant', content: response.content });
        break;
      }

      // Execute tools
      history.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tool of toolBlocks) {
        process.stdout.write(`  [${tool.name}] `);
        const result = await executeTool(tool.name, tool.input as Record<string, unknown>);
        const preview = result.length > 120 ? result.slice(0, 120) + '…' : result;
        process.stdout.write(`${preview}\n`);
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });
      }

      history.push({ role: 'user', content: toolResults });
    }

    process.stdout.write('\n');
  }

  rl.close();
  await _pool?.end();
}

runAgent().catch(err => {
  console.error('Ошибка агента:', err.message);
  process.exit(1);
});
