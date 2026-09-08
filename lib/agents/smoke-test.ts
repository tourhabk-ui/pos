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
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { tgSend } from '@/lib/notifications/tg-send';

/**
 * Исход дымовой проверки. ТРИ значения, а не два (§4.0).
 *
 * Находка аудита 08.09: `passed` было булевым, и `true` возвращалось при
 * отказе БД (`db_error`), при непроверяемом заявлении без ID (`skip`) и при
 * полном провале генерации (`all_errors`). Отсюда это уезжало в
 * `app/api/cron/editor/route.ts`, где `status: smoke.passed ? 'success' :
 * 'failed'` записывало прогон УСПЕШНЫМ — и дальше та же строка кормила
 * проверки Watchdog. Сломанный Editor выглядел работающим на всём пути.
 *
 * `unknown` — «проверить не смог»: не повод краснеть, но и не успех.
 */
export type SmokeVerdict = 'passed' | 'failed' | 'unknown';

export interface SmokeResult {
  /** Проверка пройдена ДОКАЗАННО. Не путать с «не нашли проблем». */
  passed: boolean;
  verdict: SmokeVerdict;
  kind: 'ok' | 'silent_fail' | 'partial_write' | 'under_spec' | 'all_errors'
      | 'zero_processed' | 'skip' | 'db_error';
  claimed: number;
  actual: number;
  message: string;
}

/**
 * Тревога дымовой проверки — общим отправителем (`lib/notifications/tg-send.ts`).
 *
 * Fire-and-forget оставлен намеренно: проверка не должна ждать Telegram. Но
 * отказ доставки теперь попадает в лог, а не растворяется в `.catch(() => {})`.
 */
function sendTgAlertAsync(text: string): void {
  void tgSend('smoke-test', text);
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
    return { passed: true, verdict: 'passed', kind: 'zero_processed', claimed: 0, actual: 0, message: 'Очередь пуста — нечего обрабатывать' };
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
    // Обработал N, улучшил 0 — это провал прогона, а не успех: раньше
    // отсюда уходило passed: true, и прогон записывался как 'success'.
    return { passed: false, verdict: 'failed', kind: 'all_errors', claimed: 0, actual: 0, message: msg };
  }

  // Основная проверка: claimed > 0 — мерим конкретные строки по ID
  if (ids.length === 0) {
    // Агент заявил улучшения и не назвал ни одной строки: проверить нечем.
    // Это «не знаю», а не «хорошо».
    return {
      passed: false, verdict: 'unknown', kind: 'skip', claimed: improved, actual: -1,
      message: `Агент заявил ${improved} улучшений и не передал ни одного ID — проверить заявление нечем`,
    };
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
      return { passed: false, verdict: 'failed', kind: 'silent_fail', claimed: improved, actual: 0, message: msg };
    }

    // Записано, но часть описаний короче контракта 300 — под-спек (не блокер, но сигнал)
    if (goalMet < written) {
      const msg =
        `<b>SMOKE WARN: Editor — под-спек</b>\n` +
        `Записано ${written}/${ids.length} строк, но контракту (>= ${GOAL_MIN} симв) удовлетворяют только <b>${goalMet}</b>.\n` +
        `Короткие описания будут снова выбраны на следующем прогоне. Проверь промпт/обрезку в editor.ts.`;
      sendTgAlertAsync(msg);
      return { passed: true, verdict: 'passed', kind: 'under_spec', claimed: improved, actual: written, message: msg };
    }

    // Часть строк не записалась. Прежде эта ветка не проверялась вовсе:
    // сравнивали goalMet с written, но не written с числом заявленных ID, —
    // и «записано 1 из 20» возвращалось как kind 'ok' с passed: true.
    if (written < ids.length) {
      const msg =
        `<b>SMOKE FAIL: Editor — записалось не всё</b>\n` +
        `Агент заявил ${improved} улучшений (ID: ${ids.length}), реально с описанием ` +
        `в БД: <b>${written}</b>. Потеряно ${ids.length - written}.\n` +
        `Проверь триггер ark_view_update и ветку записи в editor.ts.`;
      sendTgAlertAsync(msg);
      return { passed: false, verdict: 'failed', kind: 'partial_write', claimed: improved, actual: written, message: msg };
    }

    return {
      passed: true,
      verdict: 'passed',
      kind: 'ok',
      claimed: improved,
      actual: written,
      message: `OK: claimed ${improved}, записано ${written}/${ids.length}, контракту >= ${GOAL_MIN} удовлетворяют ${goalMet}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Проверка НЕ ВЫПОЛНИЛАСЬ. Раньше отсюда уходило passed: true, то есть
    // отказ базы записывался как успешный прогон Editor.
    logSwallowedFailure('smoke-test', 'сверка записей Editor', err);
    return {
      passed: false, verdict: 'unknown', kind: 'db_error', claimed: improved, actual: -1,
      message: `Сверку выполнить не удалось (БД): ${msg}. Это не «записалось», а «не проверено».`,
    };
  }
}

/**
 * Проверяет что агент реально записал новые записи в agent_memory.
 */
export async function smokeTestMemoryWrites(
  agentId: string,
  claimed: number,
  startedAt: Date,
  /**
   * Какой РОД записей считать. Без него проверка считает всё, что агент
   * тронул за прогон, — включая собственную отметку «последний запуск». Тогда
   * «заявил 5 предложений, сохранил 0» выглядит успехом: одна строка-то есть.
   * Проверка, которую нельзя провалить, — не проверка.
   */
  memoryType?: string,
): Promise<SmokeResult> {
  if (claimed === 0) {
    // Заявлено ноль — сверять нечего, и это честный ноль, а не отказ.
    return { passed: true, verdict: 'passed', kind: 'skip', claimed: 0, actual: 0, message: 'Заявлено 0 — сверять нечего' };
  }

  try {
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM agent_memory
       WHERE agent_id = $1 AND updated_at >= $2
         AND ($3::text IS NULL OR memory_type = $3)`,
      [agentId, startedAt, memoryType ?? null],
    );

    const actual = parseInt(rows[0]?.cnt ?? '0', 10);

    if (actual === 0) {
      const msg =
        `<b>SMOKE FAIL: ${agentId}</b>\n` +
        `Агент сообщил: <b>${claimed}</b> записей в памяти\n` +
        `Реально записано: <b>0</b> (agent_memory${memoryType ? `, род «${memoryType}»` : ''} ` +
        `с ${startedAt.toISOString().slice(0, 16)})\n` +
        `Тихая ошибка — данные НЕ сохранены.`;
      sendTgAlertAsync(msg);
      return { passed: false, verdict: 'failed', kind: 'silent_fail', claimed, actual: 0, message: msg };
    }

    // Записалось МЕНЬШЕ заявленного — тоже провал: часть записей потеряна.
    // Прежде сравнивали только с нулём, и «заявил 20, записал 1» проходило.
    if (actual < claimed) {
      const msg =
        `<b>SMOKE FAIL: ${agentId} — записалось не всё</b>\n` +
        `Заявлено ${claimed}, реально записано ${actual}. Потеряно ${claimed - actual}.`;
      sendTgAlertAsync(msg);
      return { passed: false, verdict: 'failed', kind: 'partial_write', claimed, actual, message: msg };
    }
    return { passed: true, verdict: 'passed', kind: 'ok', claimed, actual, message: `OK: заявлено ${claimed}, записано ${actual}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSwallowedFailure('smoke-test', `сверка записей ${agentId}`, err);
    return {
      passed: false, verdict: 'unknown', kind: 'db_error', claimed, actual: -1,
      message: `Сверку выполнить не удалось (БД): ${msg}. Это не «записалось», а «не проверено».`,
    };
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
    // Заявлено ноль — сверять нечего, и это честный ноль, а не отказ.
    return { passed: true, verdict: 'passed', kind: 'skip', claimed: 0, actual: 0, message: 'Заявлено 0 — сверять нечего' };
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
      return { passed: false, verdict: 'failed', kind: 'silent_fail', claimed, actual: 0, message: msg };
    }

    // Записалось МЕНЬШЕ заявленного — тоже провал: часть записей потеряна.
    // Прежде сравнивали только с нулём, и «заявил 20, записал 1» проходило.
    if (actual < claimed) {
      const msg =
        `<b>SMOKE FAIL: ${agentId} — записалось не всё</b>\n` +
        `Заявлено ${claimed}, реально записано ${actual}. Потеряно ${claimed - actual}.`;
      sendTgAlertAsync(msg);
      return { passed: false, verdict: 'failed', kind: 'partial_write', claimed, actual, message: msg };
    }
    return { passed: true, verdict: 'passed', kind: 'ok', claimed, actual, message: `OK: заявлено ${claimed}, записано ${actual}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSwallowedFailure('smoke-test', `сверка записей ${agentId}`, err);
    return {
      passed: false, verdict: 'unknown', kind: 'db_error', claimed, actual: -1,
      message: `Сверку выполнить не удалось (БД): ${msg}. Это не «записалось», а «не проверено».`,
    };
  }
}
