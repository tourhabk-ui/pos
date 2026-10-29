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
 * Молчание сети (ревью 29.10): приёмники, принимавшие раньше, разом в серии
 * сетевых неудач и с её начала не доставлено ничего (поле stall). Ответ
 * остаётся 200 — красить сердцевину отказами чужих адресов нельзя (критика
 * 29.10), — но прогон пишется `partial` с причиной notify_stalled, и серию
 * таких прогонов называет сторож «крон идёт, результата нет» (Watchdog).
 *
 * Разбор одной подписки — `?ref=nr_…` (номер из ответа инструмента): только
 * чтение, без прогона; ответ — коды, числа, время и хэш последнего тела, без
 * адреса и хоста. Нет такой — 404; номер не той формы — 400.
 *
 * Тело ответа печатается в ПУБЛИЧНЫЙ лог Actions (`cat` в шаге), поэтому в нём
 * только числа, машинные коды и SQLSTATE — никогда текст ошибки: в сетевых
 * ошибках Node и в части ошибок pg стоит хост приёмника или значение.
 */

import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { z } from 'zod';
import { runRequestNotify, readNotifyCensus, NOTIFY_REF_RE } from '@/lib/mcp/request-notify';

export const dynamic = 'force-dynamic';

const AGENT_ID = 'agent-request-notify';

const censusQuery = z.object({
  ref: z.string().trim().regex(NOTIFY_REF_RE, 'ref: номер подписки вида nr_… — как в ответе пишущего инструмента'),
});

function sqlstateOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'none';
}

/** Разбор одной подписки по номеру. Только чтение, прогона нет. */
async function census(rawRef: string): Promise<Response> {
  const parsed = censusQuery.safeParse({ ref: rawRef });
  if (!parsed.success) {
    return Response.json({ success: false, error: parsed.error.issues[0]?.message ?? 'ref: неверный номер подписки' }, { status: 400 });
  }
  try {
    const sub = await readNotifyCensus(parsed.data.ref);
    if (!sub) {
      return Response.json({ success: false, error: 'Подписки с таким номером нет: не заводилась или удалена через 30 дней после отключения.' }, { status: 404 });
    }
    return Response.json({ success: true, mode: 'census', subscription: sub });
  } catch (e) {
    const state = sqlstateOf(e);
    console.error(`[agent-notify] разбор подписки не прочитан: SQLSTATE=${state}`);
    return Response.json({ success: false, mode: 'census', sqlstate: state }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  if (!process.env.CRON_SECRET) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, process.env.CRON_SECRET)) return Response.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });

  const ref = new URL(req.url).searchParams.get('ref');
  if (ref !== null) return census(ref);

  const started = Date.now();
  // runRequestNotify не бросает: исход — в status. Ловушка ниже — на случай,
  // если бросит всё же (ошибка кода): ответ и тогда без текста ошибки.
  try {
    const r = await runRequestNotify();
    if (r.status === 'ok') {
      if (r.stall) {
        // Только числа: тревога уходит в Telegram, хостов в ней быть не должно.
        recordCronRun(AGENT_ID, started, 'partial', {
          items: r.delivered,
          metadata: {
            skip_reason: 'notify_stalled',
            empty_reasons: [`сетевые отказы у приёмников, принимавших раньше: ${r.stall.hosts}; доставок нет ${r.stall.minutes} мин`],
          },
        });
      } else {
        recordCronRun(AGENT_ID, started, 'success', { items: r.delivered });
      }
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
