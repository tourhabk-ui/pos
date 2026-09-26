/**
 * GET /api/public/stats
 * Публичная статистика экосистемы для виджетов и интеграций.
 *
 * ── Отказ называется отказом (§4.0) ───────────────────────────────────────
 *
 * Прежний `catch` отдавал HTTP 200 с четырьмя нулями и текстом ошибки БД в
 * поле `error`. Три беды в одном месте:
 *   - нули выдавались за успех: «сегодня ни одного разговора, ни одного
 *     маршрута, ни одного агента» — измеримое утверждение о платформе,
 *     сделанное из ничего. Виджету и интегратору отличить это от правды
 *     нечем, а в статистике «ноль» и «не знаю» — разные ответы;
 *   - наружу уходило сообщение PostgreSQL (имя колонки, таблицы, иногда часть
 *     запроса) — подсказка тому, кто эту дверь и пробует;
 *   - в лог не писалось НИЧЕГО: отказ был невидим ровно до того дня, когда
 *     кто-нибудь заметил бы нули.
 *
 * Теперь: причина с SQLSTATE — в лог, наружу 503 и слова по-русски без
 * подробностей, `stats` в ответе отказа НЕТ вовсе — ни нулями, ни null.
 *
 * Кэш. `unstable_cache` кэширует ЗНАЧЕНИЕ, поэтому отказ обязан бросать, а не
 * возвращаться: иначе пустышка залегла бы в кэш на пять минут и переживала бы
 * восстановление базы. Отклонённое обещание не кэшируется — следующий запрос
 * снова спросит базу.
 *
 * Сторож: `tests/unit/public-stats-honest-failure.test.ts`.
 */

import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const PLATFORM = {
  name: 'Kamchatour Hub',
  version: '1.0.0',
  url: 'https://vedarai.ru',
} as const;

const getPublicStats = unstable_cache(
  async () => {
    try {
      const [chats, routes, agents, sos] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM chat_sessions WHERE updated_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM agent_route_knowledge WHERE is_visible = true`
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(DISTINCT metadata->>'agent_id')::text AS count FROM ai_actions_log WHERE created_at > NOW() - INTERVAL '1 hour'`
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM sos_events WHERE created_at > NOW() - INTERVAL '7 days'`
        ),
      ]);

      return {
        platform: PLATFORM,
        stats: {
          chatsToday: parseInt(chats.rows[0]?.count ?? '0', 10),
          activeRoutes: parseInt(routes.rows[0]?.count ?? '0', 10),
          activeAgents: parseInt(agents.rows[0]?.count ?? '0', 10),
          sosEventsWeek: parseInt(sos.rows[0]?.count ?? '0', 10),
        },
        timestamp: new Date().toISOString(),
        ttl: 300,
      };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[public/stats] отказ чтения статистики${typeof code === 'string' ? ` SQLSTATE ${code}` : ''} — ${message}`,
      );
      // Бросаем: значение не кэшируется, наружу пойдёт 503, а не нули.
      throw err;
    }
  },
  ['public-stats'],
  { revalidate: 300 }
);

export async function GET() {
  try {
    const stats = await getPublicStats();
    return NextResponse.json(stats, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
    });
  } catch {
    // Причина уже в логе. Наружу — только род отказа: текст ошибки БД
    // рассказывает о схеме тому, кто её и выясняет.
    return NextResponse.json(
      {
        platform: PLATFORM,
        error: 'Статистика временно недоступна',
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
      },
    );
  }
}
