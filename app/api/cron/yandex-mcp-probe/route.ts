/**
 * GET /api/cron/yandex-mcp-probe — российская модель ходит в Ведар.
 *
 * Повод (владелец 13.10): «остались российские ИИ». Китайский контур того же
 * дня закончился живым разговором: DeepSeek с раннера позвала инструменты
 * Ведара и ответила по данным. Здесь тот же вопрос — российским моделям. Из
 * них задокументированный путь «модель сама зовёт чужой MCP-сервер» есть у
 * одного Яндекса: Responses API AI Studio с инструментом `type: mcp`
 * (callYandexAgentWithMcp, lib/ai/providers). GigaChat зовёт MCP только через
 * LangChain-адаптеры на стороне разработчика, у Алисы пути нет — им здесь
 * спрашивать нечем, и это записано в docs/agents/RUSSIA.md, а не замолчано.
 *
 * С ПРОДА, не с раннера: YANDEX_API_KEY и YANDEX_FOLDER_ID лежат в
 * переменных Timeweb, путь из РФ в Яндекс — наш путь. Сервер, который агент
 * зовёт, — наш же публичный MCP (`<getPublicBaseUrl()>/api/mcp`): вызовы
 * ложатся в журнал mcp_tool_calls как внешние, и роут читает журнал за окно
 * пробы, чтобы увидеть, КАКИМ ИМЕНЕМ представляется шлюз Яндекса — реестр
 * lib/mcp/ru-clients пополняется по этому имени, а не по догадке. В окно
 * могут попасть и чужие вызовы той же минуты — поэтому журнал приложен как
 * улика рядом с ответом, а не подменяет его.
 *
 * Три исхода (§4.0), третий не равен второму:
 *   called_tools            — в ответе есть элементы mcp_call: модель ходила
 *                             в Ведар; имена инструментов приложены;
 *   answered_without_tools  — ответ есть, mcp_call нет: модель ответила из
 *                             головы (или форма ответа Яндекса не несёт
 *                             mcp_call — тогда журнал за окно пробы покажет
 *                             вызовы, и вердикт это называет);
 *   could_not_ask           — ключа нет, провайдер отказал (у ключа старого
 *                             образца может не быть права
 *                             yc.serverless.mcpGateways.invoke — 403),
 *                             таймаут: причина из обёртки, не пустота.
 *
 * Вопрос — тот же, что китайским моделям в мосте, по-русски. Пишущих
 * инструментов модель не зовёт по инструкции в вопросе; заявок проба не
 * создаёт.
 *
 * Запуск — yandex-mcp-probe.yml по маркеру .github/triggers/yandex-mcp-probe.json.
 * Сторож: tests/unit/yandex-mcp-probe.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { getPublicBaseUrl } from '@/lib/config';
import { callYandexAgentWithMcp, type YandexMcpAgentResult } from '@/lib/ai/providers';
import { runPlace } from '@/lib/ai/key-identity';
import { clientRegion } from '@/lib/mcp/china-clients';
import { isProbeClient } from '@/lib/mcp/probe-clients';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export type YandexProbeOutcome = 'called_tools' | 'answered_without_tools' | 'could_not_ask';

/** Тот же вопрос, что в мосте китайским моделям, — по-русски; без заявок. */
export const YANDEX_PROBE_QUESTION =
  'Еду на Камчатку в августе. Где можно увидеть бурых медведей и безопасно ли там сейчас? '
  + 'Отвечай только по данным инструментов сервера vedar: сначала посмотри обстановку и туры, '
  + 'затем ответь коротко, с названиями мест и туров. Заявок, броней и запросов не создавай.';

export const MCP_SERVER_LABEL = 'vedar';
export const MCP_SERVER_DESCRIPTION =
  'Ведар — данные Камчатки: обстановка в крае и безопасность мест, туры и их реальная занятость, '
  + 'погода, жильё, трансферы, план поездки. Для ответа туристу зови инструменты чтения.';

/** Окно журнала начинается чуть раньше запроса: часы прода и запись журнала не синхронны до секунды. */
const JOURNAL_LEAD_MS = 2_000;
const ANSWER_EXCERPT = 600;

interface JournalRow { client: string; tool: string; ok: boolean; error_kind: string | null; at: string }

export interface JournalDuringProbe {
  since: string;
  calls: number;
  clients: Array<{ client: string; calls: number; region: string | null; probe: boolean }>;
  tools: string[];
  /** Ошибка чтения журнала — не «вызовов не было». */
  failed: string | null;
}

async function journalSince(sinceIso: string): Promise<JournalDuringProbe> {
  try {
    const { rows } = await pool.query<JournalRow>(
      `SELECT COALESCE(c.client_name, c.ua_family, 'не представился') AS client, t.tool, t.ok, t.error_kind,
              to_char(t.created_at, 'HH24:MI:SS') AS at
         FROM mcp_tool_calls t
         LEFT JOIN mcp_clients c ON c.caller_hash = t.caller_hash AND c.day = t.created_at::date
        WHERE t.created_at >= $1::timestamptz AND t.is_self = FALSE
        ORDER BY t.created_at LIMIT 50`,
      [sinceIso],
    );
    const byClient = new Map<string, number>();
    for (const r of rows) byClient.set(r.client, (byClient.get(r.client) ?? 0) + 1);
    return {
      since: sinceIso,
      calls: rows.length,
      clients: [...byClient].map(([client, calls]) => ({ client, calls, region: clientRegion(client), probe: isProbeClient(client, null) })),
      tools: [...new Set(rows.map((r) => r.tool))],
      failed: null,
    };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[yandex-mcp-probe] журнал за окно пробы не прочитался:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return { since: sinceIso, calls: 0, clients: [], tools: [], failed: `${e?.code ?? 'ERR'}: ${e?.message ?? 'неизвестная ошибка'}` };
  }
}

export function decideOutcome(r: Pick<YandexMcpAgentResult, 'error' | 'answer' | 'mcp_calls'>): { outcome: YandexProbeOutcome; reason: string | null } {
  if (r.error) return { outcome: 'could_not_ask', reason: r.error };
  if (r.mcp_calls.length > 0) return { outcome: 'called_tools', reason: null };
  if (r.answer) return { outcome: 'answered_without_tools', reason: 'ответ есть, элементов mcp_call в output нет' };
  return { outcome: 'could_not_ask', reason: 'ответ без текста и без вызовов инструментов' };
}

export function verdictFor(outcome: YandexProbeOutcome, reason: string | null, r: Pick<YandexMcpAgentResult, 'mcp_calls'>, journal: JournalDuringProbe | null): string {
  const seen = journal?.clients.filter((c) => !c.probe) ?? [];
  const names = seen.map((c) => `«${c.client}»${c.region ? ` [${c.region}]` : ''} (${c.calls})`).join(', ');
  const journalNote = journal === null
    ? ''
    : journal.failed
      ? `; журнал за окно пробы не прочитался: ${journal.failed}`
      : names
        ? `; в журнале за окно пробы: ${names}`
        : '; в журнале за окно пробы внешних вызовов нет';
  switch (outcome) {
    case 'called_tools': {
      const tools = r.mcp_calls.map((c) => c.name ?? '?').join(', ');
      return `модель Яндекса позвала инструменты Ведара ${r.mcp_calls.length} раз (${tools}) и ответила${journalNote || '; в журнале за окно пробы вызовов нет — смотреть, доходит ли шлюз до /api/mcp'}`;
    }
    case 'answered_without_tools':
      return names
        ? `модель ответила без элементов mcp_call, но в журнале за окно пробы есть вызовы: ${names} — возможно, форма ответа Яндекса их не несёт; имя клиента — в lib/mcp/ru-clients.ts`
        : `модель ответила, не позвав ни одного инструмента Ведара — не подключена${journalNote}`;
    case 'could_not_ask':
      return `спросить не удалось: ${reason ?? 'причина не названа'}`;
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const mcpUrl = `${getPublicBaseUrl().replace(/\/$/, '')}/api/mcp`;
  const askedAt = new Date();
  const since = new Date(askedAt.getTime() - JOURNAL_LEAD_MS).toISOString();
  const r = await callYandexAgentWithMcp(YANDEX_PROBE_QUESTION, {
    mcpUrl, serverLabel: MCP_SERVER_LABEL, description: MCP_SERVER_DESCRIPTION, timeoutMs: 100_000,
  });
  // Без ключа запроса не было — и в журнале искать нечего.
  const journal = r.error?.startsWith('no_key') ? null : await journalSince(since);
  const { outcome, reason } = decideOutcome(r);

  return NextResponse.json({
    ok: outcome === 'called_tools',
    outcome,
    reason,
    place: runPlace(),
    asked_at: askedAt.toISOString(),
    question: YANDEX_PROBE_QUESTION,
    mcp_url: mcpUrl,
    model: r.model,
    http_status: r.http_status,
    latency_ms: r.latency_ms,
    output_types: r.output_types,
    listed_tools: r.listed_tools,
    mcp_calls: r.mcp_calls,
    answer_excerpt: r.answer ? r.answer.slice(0, ANSWER_EXCERPT) : null,
    journal_during_probe: journal,
    verdict: verdictFor(outcome, reason, r, journal),
  });
}
