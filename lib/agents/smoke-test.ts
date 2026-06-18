/**
 * lib/agents/smoke-test.ts
 *
 * Ловит самый дорогой класс багов: агент говорит "N улучшено", но БД не изменилась.
 * (Исторически: editor.ts месяцами возвращал { improved: 5 }, не записав ни строки.)
 *
 * Каждый тест принимает:
 *   - claimed: сколько агент сообщил об изменениях
 *   - startedAt: время начала запуска (порог для updated_at)
 *
 * Если claimed > 0 но фактических изменений 0 → SILENT FAILURE → Telegram алерт.
 */

import { pool } from '@/lib/db-pool';

interface SmokeResult {
  passed: boolean;
  claimed: number;
  actual: number;
  message: string;
}

async function sendTgAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

/**
 * Проверяет что editor реально обновил описания в places / kamchatka_routes.
 * claimed: количество из editor result.improved
 * startedAt: время начала запуска editor
 */
export async function smokeTestEditorWrites(
  claimed: number,
  startedAt: Date,
): Promise<SmokeResult> {
  if (claimed === 0) {
    return { passed: true, claimed: 0, actual: 0, message: 'Claimed 0 — skip' };
  }

  try {
    const [placesResult, routesResult] = await Promise.all([
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM places WHERE updated_at >= $1`,
        [startedAt],
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM kamchatka_routes WHERE updated_at >= $1`,
        [startedAt],
      ),
    ]);

    const actual =
      parseInt(placesResult.rows[0]?.cnt ?? '0', 10) +
      parseInt(routesResult.rows[0]?.cnt ?? '0', 10);

    if (actual === 0) {
      const msg =
        `<b>SMOKE FAIL: Editor</b>\n` +
        `Агент сообщил: <b>${claimed}</b> улучшено\n` +
        `Реально изменено в БД: <b>0</b> строк (places + kamchatka_routes с ${startedAt.toISOString().slice(0, 16)})\n` +
        `Тихая ошибка — описания НЕ записаны. Проверь editor.ts и триггер на agent_route_knowledge.`;
      await sendTgAlert(msg);
      return { passed: false, claimed, actual: 0, message: msg };
    }

    return {
      passed: true,
      claimed,
      actual,
      message: `OK: claimed ${claimed}, actual ${actual} rows updated`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: true, claimed, actual: -1, message: `Smoke test skipped (DB error): ${msg}` };
  }
}

/**
 * Проверяет что агент реально записал новые записи в agent_memory.
 * claimed: количество записей которые агент сообщил о создании
 * agentId: идентификатор агента
 * startedAt: время начала запуска
 */
export async function smokeTestMemoryWrites(
  agentId: string,
  claimed: number,
  startedAt: Date,
): Promise<SmokeResult> {
  if (claimed === 0) {
    return { passed: true, claimed: 0, actual: 0, message: 'Claimed 0 — skip' };
  }

  try {
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM agent_memory
       WHERE agent_id = $1 AND updated_at >= $2`,
      [agentId, startedAt],
    );

    const actual = parseInt(rows[0]?.cnt ?? '0', 10);

    if (actual === 0) {
      const msg =
        `<b>SMOKE FAIL: ${agentId}</b>\n` +
        `Агент сообщил: <b>${claimed}</b> записей в памяти\n` +
        `Реально записано: <b>0</b> (agent_memory с ${startedAt.toISOString().slice(0, 16)})\n` +
        `Тихая ошибка — данные НЕ сохранены. Проверь агент ${agentId}.`;
      await sendTgAlert(msg);
      return { passed: false, claimed, actual: 0, message: msg };
    }

    return {
      passed: true,
      claimed,
      actual,
      message: `OK: claimed ${claimed}, actual ${actual} agent_memory rows`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: true, claimed, actual: -1, message: `Smoke test skipped (DB error): ${msg}` };
  }
}

/**
 * Проверяет что агент записал новые знания в agent_knowledge.
 * claimed: количество страниц знаний которые агент должен был создать/обновить
 * agentId: идентификатор агента
 * startedAt: время начала запуска
 */
export async function smokeTestKnowledgeWrites(
  agentId: string,
  claimed: number,
  startedAt: Date,
): Promise<SmokeResult> {
  if (claimed === 0) {
    return { passed: true, claimed: 0, actual: 0, message: 'Claimed 0 — skip' };
  }

  try {
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM agent_knowledge
       WHERE agent_id = $1 AND updated_at >= $2`,
      [agentId, startedAt],
    );

    const actual = parseInt(rows[0]?.cnt ?? '0', 10);

    if (actual === 0) {
      const msg =
        `<b>SMOKE FAIL: ${agentId}</b>\n` +
        `Агент сообщил: <b>${claimed}</b> страниц знаний\n` +
        `Реально записано: <b>0</b> (agent_knowledge с ${startedAt.toISOString().slice(0, 16)})\n` +
        `Тихая ошибка — знания НЕ сохранены. Проверь агент ${agentId}.`;
      await sendTgAlert(msg);
      return { passed: false, claimed, actual: 0, message: msg };
    }

    return {
      passed: true,
      claimed,
      actual,
      message: `OK: claimed ${claimed}, actual ${actual} agent_knowledge rows`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: true, claimed, actual: -1, message: `Smoke test skipped (DB error): ${msg}` };
  }
}
