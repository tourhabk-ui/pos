/**
 * Журнал запросов A2A — кто приходит по второму протоколу (решение владельца
 * 12.10: «я бы хотел видеть в админ-хабе A2A, хотя бы кто заходит из ИИ»).
 *
 * ── Почему отдельный журнал ───────────────────────────────────────────────
 *
 * До 12.10 след A2A был неполным: вызов инструмента через DataPart уходил в
 * mcp_tool_calls тем же путём, что MCP (runPublicTool), и от MCP-вызова ничем
 * не отличался; текстовый вопрос Кузьмичу не писался нигде; чтение визитки с
 * /api/a2a и /api/a2a/v1 не считал никто. Строка lib/a2a/catalogs.ts «в
 * журнале A2A будут его вопросы» описывала журнал, которого не было (§10.09).
 *
 * ── Что пишется и что нет ─────────────────────────────────────────────────
 *
 * Факт запроса: биндинг, операция, версия протокола и был ли заголовок, вид
 * входа (текст / инструмент), имя инструмента из реестра, состояние задачи,
 * ошибка протокола, длительность, самоназвание программы, род по заголовку,
 * суточный hash вызывающего (тот же, что у MCP — журналы соединяются по
 * дню), hash контекста (считать диалоги), метка «свой».
 *
 * Сырой User-Agent и IP НЕ хранятся — та же граница, что у mcp_clients (872)
 * и agent_entry_hits (1218). У A2A нет рукопожатия с clientInfo, поэтому
 * «кто» берётся из заголовка, но не целиком: только самоназвание программы
 * (`A2A-Registry-TaskProbe`, `python-requests`, `GPTBot`) — без версии,
 * платформы и комментариев в скобках; браузер остаётся «браузер». Текст
 * вопроса, аргументы инструмента и contextId в открытом виде не пишутся: в
 * них могут быть имя и телефон туриста (152-ФЗ).
 *
 * Fire-and-forget: ответ агенту важнее журнала, но отказ записи называется в
 * логе с SQLSTATE (§4.0) — молчащий журнал читался бы как «никто не ходит».
 *
 * Читает /api/admin/analytics/a2a → страница /hub/admin/a2a.
 * Сторож: tests/unit/a2a-journal-admin.test.ts.
 */

import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { mcpCallerHash, safeToolName } from '@/lib/mcp/call-log';
import { uaFamily } from '@/lib/mcp/client-id';
import { PROBE_NAME_PATTERN } from '@/lib/mcp/probe-clients';
import { BOT_FAMILIES } from '@/lib/analytics/bot-detect';
import type { A2AOperation } from '@/lib/a2a/wire';

export type A2aBinding = 'jsonrpc' | 'rest';
/** Операции журнала: диспетчерские, визитка, уведомление JSON-RPC и отказ до диспетчера. */
export type A2aJournalOp = A2AOperation | 'card' | 'notification' | 'invalid';
export type A2aInput = 'text' | 'tool';
export type A2aTaskState = 'completed' | 'rejected' | 'failed';
/** Кто это: внешний агент, проверка реестра A2A, иная проверка (curl, пробы) или свой клиент. */
export type A2aAgentKind = 'external' | 'registry' | 'probe' | 'self';

export interface A2aJournalEntry {
  binding: A2aBinding;
  op: A2aJournalOp;
  /** Версия протокола; при отказе по версии — что просили (до 8 знаков). */
  version: string;
  versionDeclared: boolean;
  ok: boolean;
  /** Род ошибки протокола (A2AErrorKind или отказ до диспетчера); только при !ok. */
  errorCode?: string | null;
  input?: A2aInput | null;
  tool?: string | null;
  state?: A2aTaskState | null;
  /** contextId агента — в журнал уходит только hash. */
  contextId?: string | null;
  durationMs?: number | null;
  ip: string;
  userAgent: string;
  self: boolean;
}

export const AGENT_LABEL_MAX = 64;
export const UNKNOWN_AGENT = 'не представился';

/** Родовые токены браузерной строки — сами по себе не называют программу. */
const GENERIC_TOKENS = new Set([
  'mozilla', 'applewebkit', 'khtml', 'gecko', 'safari', 'chrome', 'chromium', 'crios', 'version',
  'mobile', 'edg', 'edge', 'edga', 'opr', 'firefox', 'fxios', 'like', 'yabrowser',
]);

const BOT_MARKERS = BOT_FAMILIES.flatMap((f) => f.markers);

/**
 * Самоназвание программы из User-Agent — не строка целиком.
 *
 * Порядок: известный обходчик из реестра семейств (как он себя пишет:
 * «GPTBot», «Bytespider», «Sogou web spider»); иначе первый токен вида
 * Name/Version, который не родовой браузерный (`python-requests/2.32` →
 * `python-requests`, `Mozilla/5.0 (compatible; Foo/1.0)` → `Foo`); только
 * родовые токены — «браузер»; без слэша — первое слово; пусто — «не
 * представился». Версии, платформы и комментарии в скобках не попадают
 * никогда: это имя программы, а не отпечаток устройства.
 */
export function agentLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (!ua) return UNKNOWN_AGENT;
  const lower = ua.toLowerCase();
  for (const marker of BOT_MARKERS) {
    const i = lower.indexOf(marker);
    if (i >= 0) return ua.slice(i, i + marker.length).slice(0, AGENT_LABEL_MAX);
  }
  const tokens = [...ua.matchAll(/([A-Za-z][A-Za-z0-9._+-]{0,62})\/\d/g)].map((m) => m[1]);
  const own = tokens.find((t) => !GENERIC_TOKENS.has(t.toLowerCase()));
  if (own) return own.slice(0, AGENT_LABEL_MAX);
  if (tokens.length > 0) return 'браузер';
  const word = /^[A-Za-z][A-Za-z0-9._+-]{0,62}/.exec(ua)?.[0];
  return word ? word.slice(0, AGENT_LABEL_MAX) : 'не разобран';
}

const REGISTRY_RE = /^A2A-Registry-/i;
const PROBE_RE = new RegExp(PROBE_NAME_PATTERN, 'i');

/**
 * Кто это — по самоназванию и метке, не по адресу. Реестр A2A раз в сутки
 * шлёт настоящий message/send (`A2A-Registry-TaskProbe/1.0`, при регистрации
 * `A2A-Registry-Smoke/1.0`) — это не турист и не чужой агент; прочие пробы —
 * по образцу ремесла из lib/mcp/probe-clients и по curl.
 */
export function a2aAgentKind(agent: string, family: string, isSelf: boolean): A2aAgentKind {
  if (isSelf) return 'self';
  if (REGISTRY_RE.test(agent)) return 'registry';
  if (PROBE_RE.test(agent) || family === 'curl') return 'probe';
  return 'external';
}

/** Диалог считается, а не читается: 32 знака sha256 от contextId. */
export function contextKey(contextId: string | null | undefined): string | null {
  if (!contextId) return null;
  return createHash('sha256').update(contextId).digest('hex').slice(0, 32);
}

export interface SendMessageFacts {
  contextId: string | null;
  state: A2aTaskState | null;
  input: A2aInput | null;
  tool: string | null;
}

/**
 * Факты из закодированного результата SendMessage — обеих форм: 1.0 отдаёт
 * `{ task }`, 0.3 — Task как есть с `kind: 'task'`; состояние в 1.0 —
 * `TASK_STATE_COMPLETED`, в 0.3 — `completed`. Берётся из ответа, а не
 * считается заново: второе правило перевода исхода разошлось бы с первым.
 */
export function sendMessageFacts(result: Record<string, unknown>): SendMessageFacts {
  const inner = result.task;
  const task = (inner && typeof inner === 'object' ? inner : result) as Record<string, unknown>;
  const status = (task.status ?? {}) as Record<string, unknown>;
  const rawState = typeof status.state === 'string' ? status.state.toLowerCase().replace(/^task_state_/, '') : '';
  const state: A2aTaskState | null = rawState === 'completed' || rawState === 'rejected' || rawState === 'failed' ? rawState : null;
  const metadata = (task.metadata ?? {}) as Record<string, unknown>;
  const input: A2aInput | null = metadata.input === 'text' || metadata.input === 'tool' ? metadata.input : null;
  const tool = typeof metadata.tool === 'string' ? safeToolName(metadata.tool) : null;
  const contextId = typeof task.contextId === 'string' ? task.contextId : null;
  return { contextId, state, input, tool };
}

function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.slice(0, max);
}

export function logA2aRequest(entry: A2aJournalEntry): void {
  void pool
    .query(
      `INSERT INTO a2a_requests (binding, op, version, version_declared, ok, error_code, input, tool, state, duration_ms, agent, ua_family, caller_hash, context_key, is_self)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        entry.binding,
        clip(entry.op, 32),
        clip(entry.version, 8) ?? '0.3',
        entry.versionDeclared,
        entry.ok,
        entry.ok ? null : clip(entry.errorCode, 40),
        entry.input ?? null,
        entry.tool ? safeToolName(entry.tool) : null,
        entry.state ?? null,
        typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : null,
        agentLabel(entry.userAgent),
        uaFamily(entry.userAgent).slice(0, 24),
        mcpCallerHash(entry.ip, entry.userAgent),
        contextKey(entry.contextId),
        entry.self,
      ],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: unknown })?.code;
      console.error(
        '[a2a-journal] запись не удалась:',
        typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '',
        logText(err instanceof Error ? err.message : err, 200),
      );
    });
}
