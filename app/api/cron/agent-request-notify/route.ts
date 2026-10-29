/**
 * GET /api/cron/agent-request-notify (Authorization: Bearer <CRON_SECRET>)
 *
 * Сверка подписок агентов на изменения заявок (слово владельца 29.10: «делай,
 * я не знал про эту дыру»; миграция 1348, lib/mcp/request-notify). Для каждой
 * живой подписки — вид заявки той же функцией, что у get_request_status,
 * сравнение с последним доставленным снимком и подписанный POST с разницей.
 * Зовёт cron-safety-heartbeat.yml каждые 30 минут (шаг последним: по цене
 * отказа он дешевле SOS-моста и прочих safety-шагов).
 *
 * Исходы (§4.0): 200 — база прочиталась, каждая отправка получила исход
 * (отказ приёмника — его исход, он в числах); 502 — «не смог»: живые
 * подписки есть, а ENCRYPTION_KEY не задан (подписки не тронуты); 500 — SQL
 * упал, SQLSTATE в ответе и в логе.
 *
 * Тело ответа печатается в ПУБЛИЧНЫЙ лог Actions (`cat` в шаге), поэтому в нём
 * только числа, машинные коды и SQLSTATE — никогда текст ошибки: в сетевых
 * ошибках Node и в части ошибок pg стоит хост приёмника или значение.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { runRequestNotify } from '@/lib/mcp/request-notify';

export const dynamic = 'force-dynamic';

const AGENT_ID = 'agent-request-notify';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  if (!process.env.CRON_SECRET) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, process.env.CRON_SECRET)) return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });

  const started = Date.now();
  // runRequestNotify не бросает: исход — в status. Ловушка ниже — на случай,
  // если бросит всё же (ошибка кода): ответ и тогда без текста ошибки.
  try {
    const r = await runRequestNotify();
    if (r.status === 'ok') {
      recordCronRun(AGENT_ID, started, 'success', { items: r.delivered });
      return Response.json({ success: true, ...r });
    }
    const reason = r.status === 'no_encryption' ? 'ENCRYPTION_KEY не задан' : `SQLSTATE=${r.sqlstate ?? 'none'}`;
    recordCronRun(AGENT_ID, started, 'failed', { error: `${r.status}: ${reason}` });
    return Response.json({ success: false, ...r }, { status: r.status === 'no_encryption' ? 502 : 500 });
  } catch (e) {
    const name = e instanceof Error ? e.name : 'unknown';
    console.error(`[agent-notify] прогон упал: ${name}`);
    recordCronRun(AGENT_ID, started, 'failed', { error: `exception: ${name}` });
    return Response.json({ success: false, status: 'exception', duration_ms: Date.now() - started }, { status: 500 });
  }
}
