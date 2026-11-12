/**
 * GET /api/cron/a2a-census — перепись агентов A2A с раннера. Только чтение.
 *
 * Аудит 15.10 (CN-quick): журнал A2A (a2a_requests, миграция 1219) читался
 * только срезом /api/admin/analytics/a2a под admin-JWT — с раннера и из
 * prod-check он недостижим. Поэтому на вопрос «приходил ли китайский агент по
 * A2A» не отвечала ни одна перепись: mcp-census видит только MCP. Эта перепись
 * отдаёт агентов за окно с меткой региона (КНР / РФ — по самоназванию
 * программы из реестров lib/mcp/china-clients и ru-clients) и разводит
 * внешних агентов со своими клиентами и проверками (a2aAgentKind — то же
 * правило, что у админ-среза): «китайский агент приходил» и «приходила наша
 * проба» — разные состояния.
 *
 * Три исхода (§4.0): числа; «за окно ни одного запроса» с датой, с которой
 * журнал ведётся, — ноль только что заведённой таблицы не читается как
 * «никто не ходит»; «не прочиталось» — 503 с SQLSTATE в логе.
 *
 * Перепись 12.11 (prod-check 174) ответила на «есть ли спрос на A2A» не до
 * конца: число сообщений внешних агентов пришлось складывать руками, какие
 * инструменты они звали — не было видно вовсе, а `vedar-eval` (наш экзамен
 * Кузьмича) и `vedar-research` (чьё — не записано нигде) стояли среди внешних.
 * Теперь: сводка внешних с сообщениями и исходами; вызовы инструментов внешних
 * по именам, пишущие отмечены; имена «как у наших», которых нет в списке
 * проверок, — отдельной строкой и без переноса в другой род: чьи они, перепись
 * не знает и так и говорит.
 *
 * Сырых User-Agent и IP в журнале нет by construction; caller_hash наружу не
 * отдаётся — только число суточных ключей. Ничего не пишет ни при каком
 * аргументе. Запуск — рукой или из prod-check.json (род manual в
 * cron-schedulers). Сторож: tests/unit/china-quick.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { a2aAgentKind, type A2aAgentKind } from '@/lib/a2a/agent-kind';
import { clientRegion, CHINA_REGION_LABEL } from '@/lib/mcp/china-clients';
import { RU_REGION_LABEL } from '@/lib/mcp/ru-clients';
import { WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const KINDS: readonly A2aAgentKind[] = ['external', 'registry', 'probe', 'self'];

/** Чего перепись не знает — вслух, чтобы метка региона не читалась как география. */
export const CAVEATS = [
  'регион — по самоназванию программы из реестров КНР и РФ, не по IP: null значит «не из реестра», а не «не из Китая»',
  'вызовы инструментов через MCP считает mcp-census; обходчиков визиток и манифестов — agent-entry-census',
  'external_tools — только сообщения A2A с вызовом инструмента (DataPart); вопросы текстом Кузьмичу в них не входят; tool: null — имя инструмента в журнал не записано',
  'named_like_ours — имя начинается с «vedar», в списке проверок его нет: чьи это программы, перепись не знает; в числе внешних они есть',
] as const;

/** Имя как у наших программ. Это примета, а не род: `vedar-eval` стал проверкой по списку, не по ней. */
const NAMED_LIKE_OURS_RE = /^vedar/i;

export interface A2aCensusAgentRow {
  agent: string;
  ua_family: string;
  is_self: boolean;
  requests: number;
  sends: number;
  text_sends: number;
  tool_sends: number;
  completed: number;
  rejected: number;
  failed: number;
  protocol_errors: number;
  card_reads: number;
  caller_days: number;
  first_seen: string;
  last_seen: string;
}

/** Вызовы инструментов через A2A: одна строка на агента и инструмент. */
export interface A2aCensusToolRow {
  agent: string;
  ua_family: string;
  is_self: boolean;
  tool: string | null;
  sends: number;
  completed: number;
  rejected: number;
  failed: number;
}

interface BoundsRow { since: string | null; total: number }

export function readDays(raw: string | null): number {
  const n = Number(raw ?? DEFAULT_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : DEFAULT_DAYS;
}

interface Tally { agents: number; requests: number }

const tally = (rows: ReadonlyArray<{ requests: number }>): Tally =>
  ({ agents: rows.length, requests: rows.reduce((s, r) => s + r.requests, 0) });

const VOLUME_KEYS = ['requests', 'card_reads', 'protocol_errors', 'sends', 'text_sends', 'tool_sends', 'completed', 'rejected', 'failed'] as const;
type Volume = { agents: number } & Record<(typeof VOLUME_KEYS)[number], number>;

/** Сумма по строкам агентов: запросы, чтения визитки, сообщения и их исходы. */
function volume(rows: readonly A2aCensusAgentRow[]): Volume {
  const out = { agents: rows.length } as Volume;
  for (const k of VOLUME_KEYS) out[k] = rows.reduce((s, r) => s + r[k], 0);
  return out;
}

/**
 * Разметка агентов и сводки — чистая функция над строками журнала. Регион и
 * род считаются одним правилом с админ-срезом (clientRegion, a2aAgentKind);
 * внешние отдельно от своих и проверок внутри каждого региона.
 */
export function summarizeA2aAgents(rows: readonly A2aCensusAgentRow[]) {
  const agents = rows.map((r) => ({
    ...r,
    kind: a2aAgentKind(r.agent, r.ua_family, r.is_self),
    region: clientRegion(r.agent, r.ua_family),
  }));
  const byKind = Object.fromEntries(KINDS.map((k) => [k, tally(agents.filter((a) => a.kind === k))])) as Record<A2aAgentKind, Tally>;
  const region = (label: string) => {
    const inRegion = agents.filter((a) => a.region === label);
    return {
      external: tally(inRegion.filter((a) => a.kind === 'external')),
      own_and_probes: tally(inRegion.filter((a) => a.kind !== 'external')),
      names: inRegion.map((a) => `${a.agent} (${a.kind}, ${a.requests})`),
    };
  };
  const external = agents.filter((a) => a.kind === 'external');
  const likeOurs = external.filter((a) => NAMED_LIKE_OURS_RE.test(a.agent));
  return {
    by_agent: agents,
    by_kind: byKind,
    // Спрос: что внешние агенты делали, а не только сколько раз пришли.
    external: volume(external),
    named_like_ours: {
      names: likeOurs.map((a) => `${a.agent} (${a.requests}, сообщений ${a.sends})`),
      ...volume(likeOurs),
    },
    external_without_named_like_ours: volume(external.filter((a) => !NAMED_LIKE_OURS_RE.test(a.agent))),
    china: region(CHINA_REGION_LABEL),
    ru: region(RU_REGION_LABEL),
    window_total: agents.reduce((s, a) => s + a.requests, 0),
  };
}

/**
 * Вызовы инструментов внешних агентов по именам. Род — тем же правилом, что у
 * агентов; свои, проверки и реестр сюда не входят. Пишущий инструмент (заявка)
 * отмечен: чтение каталога и оставленная заявка — разный спрос.
 */
export function summarizeA2aTools(rows: readonly A2aCensusToolRow[]) {
  const byTool = new Map<string | null, { sends: number; completed: number; rejected: number; failed: number; agents: Set<string> }>();
  for (const r of rows) {
    if (a2aAgentKind(r.agent, r.ua_family, r.is_self) !== 'external') continue;
    const t = byTool.get(r.tool) ?? { sends: 0, completed: 0, rejected: 0, failed: 0, agents: new Set<string>() };
    t.sends += r.sends;
    t.completed += r.completed;
    t.rejected += r.rejected;
    t.failed += r.failed;
    t.agents.add(r.agent);
    byTool.set(r.tool, t);
  }
  const tools = [...byTool.entries()]
    .map(([tool, t]) => ({
      tool,
      write: tool !== null && WRITE_TOOL_NAMES.has(tool),
      sends: t.sends,
      completed: t.completed,
      rejected: t.rejected,
      failed: t.failed,
      agents: t.agents.size,
      agent_names: [...t.agents].sort(),
    }))
    // По числу вызовов; «имя не записано» — после названных; дальше по имени.
    .sort((a, b) => b.sends - a.sends
      || Number(a.tool === null) - Number(b.tool === null)
      || (a.tool ?? '').localeCompare(b.tool ?? ''));
  const write = tools.filter((t) => t.write);
  return {
    tools,
    total_sends: tools.reduce((s, t) => s + t.sends, 0),
    write_sends: write.reduce((s, t) => s + t.sends, 0),
    write_completed: write.reduce((s, t) => s + t.completed, 0),
  };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const days = readDays(request.nextUrl.searchParams.get('days'));

  try {
    const [byAgent, byTool, bounds] = await Promise.all([
      pool.query<A2aCensusAgentRow>(
        `SELECT agent, ua_family, is_self,
                COUNT(*)::int                                    AS requests,
                COUNT(*) FILTER (WHERE op = 'SendMessage')::int  AS sends,
                COUNT(*) FILTER (WHERE input = 'text')::int      AS text_sends,
                COUNT(*) FILTER (WHERE input = 'tool')::int      AS tool_sends,
                COUNT(*) FILTER (WHERE state = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE state = 'rejected')::int  AS rejected,
                COUNT(*) FILTER (WHERE state = 'failed')::int    AS failed,
                COUNT(*) FILTER (WHERE NOT ok)::int              AS protocol_errors,
                COUNT(*) FILTER (WHERE op = 'card')::int         AS card_reads,
                COUNT(DISTINCT caller_hash)::int                 AS caller_days,
                to_char(MIN(created_at) AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD HH24:MI') AS first_seen,
                to_char(MAX(created_at) AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD HH24:MI') AS last_seen
           FROM a2a_requests
          WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY agent, ua_family, is_self
          ORDER BY COUNT(*) DESC, agent ASC`,
        [days],
      ),
      pool.query<A2aCensusToolRow>(
        `SELECT agent, ua_family, is_self, tool,
                COUNT(*)::int                                    AS sends,
                COUNT(*) FILTER (WHERE state = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE state = 'rejected')::int  AS rejected,
                COUNT(*) FILTER (WHERE state = 'failed')::int    AS failed
           FROM a2a_requests
          WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
            AND input = 'tool'
          GROUP BY agent, ua_family, is_self, tool`,
        [days],
      ),
      pool.query<BoundsRow>(
        `SELECT to_char(MIN(created_at) AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS since,
                COUNT(*)::int AS total
           FROM a2a_requests`,
      ),
    ]);

    const summary = summarizeA2aAgents(byAgent.rows);
    const tools = summarizeA2aTools(byTool.rows);
    const b = bounds.rows[0] ?? { since: null, total: 0 };

    return NextResponse.json({
      ok: true,
      window_days: days,
      generated_at: new Date().toISOString(),
      window_total: summary.window_total,
      // Пусто за окно — не «никто не ходит», пока не видно, с какого дня журнал ведётся.
      empty: summary.window_total === 0,
      journal_since: b.since,
      journal_total_all_time: b.total,
      note: summary.window_total === 0
        ? (b.since
          ? `за ${days} дн. ни одного запроса A2A; журнал ведётся с ${b.since}`
          : 'журнал A2A пуст целиком: запросов не было ни разу с его заведения')
        : null,
      // Четыре рода, не один: external — спрос, registry — проверка реестра A2A,
      // probe — пробы и curl, self — метка владельца.
      by_kind: summary.by_kind,
      // Спрос внешних: сообщения и исходы суммой, инструменты — по именам.
      external: summary.external,
      external_tools: tools,
      // Имя «как у наших», а в списке проверок его нет: чьё — не установлено.
      named_like_ours: summary.named_like_ours,
      external_without_named_like_ours: summary.external_without_named_like_ours,
      // Регионы: внешние отдельно от своих и проверок.
      china: summary.china,
      ru: summary.ru,
      by_agent: summary.by_agent,
      caveats: CAVEATS,
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error(
      '[a2a-census] перепись не прочитала a2a_requests:',
      typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '',
      logText(err instanceof Error ? err.message : err, 200),
    );
    return NextResponse.json(
      { ok: false, error: 'перепись не смогла прочитать a2a_requests — это отказ, а не «агентов нет»' },
      { status: 503 },
    );
  }
}
