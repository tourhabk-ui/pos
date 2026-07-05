/**
 * lib/agents/smoke-test.ts
 *
 * Ловит самый дорогой класс багов: агент говорит "N улучшено", но БД не изменилась.
 *
 * Принципы:
 * 1. Измеряем КОНКРЕТНЫЕ строки по ID — не "изменилось ли что-то в таблице за период"
 *    (иначе параллельные процессы дают false positive).
 * 2. Telegram — fire-and-forget (void, не await). DB-запись не ждёт Telegram.
 * 3. Smoke test возвращает результат — caller пишет в agent_run_history независимо.
 * 4. Детектируем "ноль из-за поломки": processed > 0 && improved = 0 → warning.
 */

import { pool } from '@/lib/db-pool';

export interface SmokeResult {
  passed: boolean;
  kind: 'ok' | 'silent_fail' | 'under_spec' | 'all_errors' | 'zero_processed' | 'skip' | 'db_error';
  claimed: number;
  actual: number;
  message: string;
}

function sendTgAlertAsync(text: string): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  // fire-and-forget — не блокирует запись в agent_run_history
  void fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
}

/**
 * Проверяет что editor реально обновил конкретные строки в places / kamchatka_routes.
 *
 * @param improved  — editor result.improved (сколько агент заявил)
 * @param ids       — editor result.improved_ids (ark_id строк которые агент заявил что тронул)
 * @param processed — editor result.processed (сколько обработано; 0 = пустая очередь или поломка)
 * @param errors    — editor result.errors (для детекции "processed > 0 && all errors")
 */
export async function smokeTestEditorWrites(
  improved: number,
  ids: string[],
  processed: number,
  errors: number,
  errorSamples: string[] = [],
): Promise<SmokeResult> {
  // Честный ноль: агент не нашёл маршрутов без описания
  if (processed === 0) {
    return { passed: true, kind: 'zero_processed', claimed: 0, actual: 0, message: 'Очередь пуста — нечего обрабатывать' };
  }

  // Подозрительный ноль: обработал N, но не улучшил ни одного (все errors)
  if (processed > 0 && improved === 0) {
    // Реальные причины из editor.error_samples вместо догадки — раньше алерт
    // хардкодил «скорее всего провайдеры», и диагностировать было нечем.
    const causes = errorSamples.length > 0
      ? `Причины (первые ${errorSamples.length}):\n${errorSamples.map(s => `— ${s}`).join('\n')}`
      : `Причины не переданы (старый формат результата) — вероятно AI-провайдеры не ответили за прогон.`;
    const msg =
      `<b>SMOKE WARN: Editor</b>\n` +
      `Обработано: ${processed} маршрутов, улучшено: 0 (ошибок: ${errors})\n` +
      `${causes}\n` +
      `Диагностика провайдеров: GET /api/ai/debug-waterfall?secret=CRON_SECRET (включая Fugu/GLM/NVIDIA).`;
    sendTgAlertAsync(msg);
    return { passed: true, kind: 'all_errors', claimed: 0, actual: 0, message: msg };
  }

  // Основная проверка: claimed > 0 — мерим конкретные строки по ID
  if (ids.length === 0) {
    return { passed: true, kind: 'skip', claimed: improved, actual: -1, message: 'IDs не переданы — пропуск проверки по строкам' };
  }

  // Два порога вместо одного «>= 100»:
  //  written — описание реально записано (детектор полного провала записи / тихой ошибки)
  //  goal    — описание удовлетворяет контракту платформы (CLAUDE.md: >= 300 символов)
  // Так оракул нельзя «обмануть» коротким наполнителем: запись короче 300 проходит как
  // under_spec-предупреждение, а не как успех (Roitman §20.2.3 — reward должен быть aligned).
  const WRITTEN_MIN = 50;
  const GOAL_MIN = 300;

  try {
    // places: id = ark_id, kamchatka_routes: id = COALESCE(ark_id, id)
    const sql = (table: string, idCol: string) =>
      `SELECT
         COUNT(*) FILTER (WHERE description IS NOT NULL AND LENGTH(description) >= $2)::text AS written,
         COUNT(*) FILTER (WHERE description IS NOT NULL AND LENGTH(description) >= $3)::text AS goal
       FROM ${table}
       WHERE ${idCol} = ANY($1::uuid[])`;

    const [placesResult, routesResult] = await Promise.all([
      pool.query<{ written: string; goal: string }>(sql('places', 'ark_id'), [ids, WRITTEN_MIN, GOAL_MIN]),
      pool.query<{ written: string; goal: string }>(sql('kamchatka_routes', 'COALESCE(ark_id, id)'), [ids, WRITTEN_MIN, GOAL_MIN]),
    ]);

    const written =
      parseInt(placesResult.rows[0]?.written ?? '0', 10) +
      parseInt(routesResult.rows[0]?.written ?? '0', 10);
    const goalMet =
      parseInt(placesResult.rows[0]?.goal ?? '0', 10) +
      parseInt(routesResult.rows[0]?.goal ?? '0', 10);

    // Полный провал записи — ничего не записано, хотя агент заявил улучшения
    if (written === 0) {
      const msg =
        `<b>SMOKE FAIL: Editor — тихая ошибка</b>\n` +
        `Агент сообщил: <b>${improved}</b> улучшено (IDs: ${ids.slice(0, 5).join(', ')}...)\n` +
        `Реально в БД (places + kamchatka_routes по этим ID): <b>0</b> строк с описанием\n` +
        `Описания НЕ записаны. Проверь триггер ark_view_update и editor.ts.`;
      sendTgAlertAsync(msg);  // fire-and-forget
      return { passed: false, kind: 'silent_fail', claimed: improved, actual: 0, message: msg };
    }

    // Записано, но часть описаний короче контракта 300 — под-спек (не блокер, но сигнал)
    if (goalMet < written) {
      const msg =
        `<b>SMOKE WARN: Editor — под-спек</b>\n` +
        `Записано ${written}/${ids.length} строк, но контракту (>= ${GOAL_MIN} симв) удовлетворяют только <b>${goalMet}</b>.\n` +
        `Короткие описания будут снова выбраны на следующем прогоне. Проверь промпт/обрезку в editor.ts.`;
      sendTgAlertAsync(msg);
      return { passed: true, kind: 'under_spec', claimed: improved, actual: written, message: msg };
    }

    return {
      passed: true,
      kind: 'ok',
      claimed: improved,
      actual: written,
      message: `OK: claimed ${improved}, записано ${written}/${ids.length}, контракту >= ${GOAL_MIN} удовлетворяют ${goalMet}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: true, kind: 'db_error', claimed: improved, actual: -1, message: `Smoke test skipped (DB error): ${msg}` };
  }
}

/**
 * Проверяет что агент реально записал новые записи в agent_memory.
 */
export async function smokeTestMemoryWrites(
  agentId: string,
  claimed: number,
  startedAt: Date,
): Promise<SmokeResult> {
  if (claimed === 0) {
    return { passed: true, kind: 'skip', claimed: 0, actual: 0, message: 'Claimed 0 — skip' };
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
        `Тихая ошибка — данные НЕ сохранены.`;
      sendTgAlertAsync(msg);
      return { passed: false, kind: 'silent_fail', claimed, actual: 0, message: msg };
    }

    return { passed: true, kind: 'ok', claimed, actual, message: `OK: claimed ${claimed}, actual ${actual}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: true, kind: 'db_error', claimed, actual: -1, message: `Smoke test skipped: ${msg}` };
  }
}

/**
 * Проверяет что агент записал новые знания в agent_knowledge.
 */
export async function smokeTestKnowledgeWrites(
  agentId: string,
  claimed: number,
  startedAt: Date,
): Promise<SmokeResult> {
  if (claimed === 0) {
    return { passed: true, kind: 'skip', claimed: 0, actual: 0, message: 'Claimed 0 — skip' };
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
        `Тихая ошибка — знания НЕ сохранены.`;
      sendTgAlertAsync(msg);
      return { passed: false, kind: 'silent_fail', claimed, actual: 0, message: msg };
    }

    return { passed: true, kind: 'ok', claimed, actual, message: `OK: claimed ${claimed}, actual ${actual}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: true, kind: 'db_error', claimed, actual: -1, message: `Smoke test skipped: ${msg}` };
  }
}
