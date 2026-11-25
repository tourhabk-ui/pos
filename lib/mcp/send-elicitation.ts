/**
 * lib/mcp/send-elicitation.ts — кнопка «отправить заявку» прямо в клиенте
 * (Elicitation в режиме url, ревизия 2026-07-28; слово владельца 25.11
 * «Да, открывай PR»).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * Заявку отправляет сам человек на /confirm (#3399, п. 4;
 * lib/mcp/human-confirmation). Ссылку на страницу модель получала текстом и
 * пересказывала человеку. Слабое место записано там же: агент с браузером
 * может открыть ссылку и нажать «Отправить» сам.
 *
 * ── Что стало ─────────────────────────────────────────────────────────────
 *
 * Если клиент modern-эпохи объявил `elicitation.url` в
 * `_meta["io.modelcontextprotocol/clientCapabilities"]`, черновик заявки
 * откладывается как раньше, но в ответ уходит не текст, а
 * `InputRequiredResult` (basic/patterns/mrtr) с одним запросом
 * `elicitation/create` в режиме `url` на ту же страницу /confirm. Клиент по
 * спеке ОБЯЗАН показать человеку адрес целиком, спросить согласия и открыть
 * страницу так, чтобы ни клиент, ни модель не видели её и не вводили за
 * человека (client/elicitation, «Safe URL Handling», п. 4). То есть кнопку
 * нажимает человек, а не модель.
 *
 * После согласия клиент повторяет тот же `tools/call` с `requestState` и
 * ответом `accept` / `decline` / `cancel`. Повтор НЕ исполняет инструмент
 * заново (второго черновика нет): сервер по `requestState` находит черновик
 * и говорит модели, как он стоит — отправлен, ждёт нажатия, отклонён, истёк.
 *
 * Клиент без `elicitation.url` (legacy-эпоха, только форма, A2A) получает
 * прежний ответ: черновик и ссылку текстом. Это запасной путь для всех.
 *
 * ── requestState ──────────────────────────────────────────────────────────
 *
 * Спека велит считать его вводом нападающего и защищать целостность, раз он
 * решает, чей черновик читать (mrtr, «Server Requirements», пп. 4–5). Здесь
 * — AES-256-GCM: целостность и заодно скрытность (токен черновика клиент и
 * так видит в адресе, но в своих журналах `requestState` ему держать незачем).
 * Внутри: инструмент, отпечаток аргументов (повтор с другими аргументами —
 * отказ), токен черновика и срок, равный сроку черновика.
 *
 * Привязки к человеку (п. 5, «authenticated principal») нет: публичный
 * сервер анонимен, подтверждённого субъекта у вызова нет. Чужой
 * `requestState` даёт только то, что и так даёт ссылка из того же ответа, —
 * узнать, отправлен ли этот черновик. Отправить по нему нельзя: отправка —
 * только со страницы (`fromVedarPage`, pending-confirm).
 *
 * Ключа нет (тесты, локально) — `InputRequiredResult` не выдаётся вовсе:
 * клиент получает прежний текстовый ответ.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { META_CLIENT_CAPABILITIES } from '@/lib/mcp/modern-request';
import { askHumanToSend } from '@/lib/mcp/human-confirmation';
import { WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { PENDING_REQUEST_TTL_MIN, confirmPageUrl, isPendingToken, readPendingRequest } from '@/lib/mcp/pending-request';

/** Шесть заявок, которые человек отправляет на /confirm (договор — tests/unit/mcp-write-contract). */
export const SEND_ELICITATION_TOOLS: ReadonlySet<string> = WRITE_TOOL_NAMES;

/** Ключ запроса в `inputRequests` и ответа в `inputResponses`. */
export const SEND_INPUT_KEY = 'vedar_send_request';

/** Что клиент покажет человеку рядом с адресом. Без имени и телефона: сообщение видит клиент. */
export const SEND_ELICITATION_MESSAGE = 'Ведар: заявка ещё не отправлена. На странице Ведара проверьте, что и кому уйдёт, '
  + 'отметьте согласие на обработку данных и сами нажмите «Отправить».';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Объявил ли клиент режим url. Пустой `elicitation: {}` по спеке значит
 * «только форма» — нам не годится: форму мы не шлём (согласие из формы сервер
 * не отличит от ответа агента, решение 15.11).
 */
export function clientTakesUrlElicitation(params: Record<string, unknown>): boolean {
  const meta = params._meta;
  if (!isObj(meta)) return false;
  const caps = meta[META_CLIENT_CAPABILITIES];
  if (!isObj(caps)) return false;
  const el = caps.elicitation;
  return isObj(el) && isObj(el.url);
}

function stateKey(): Buffer | null {
  const s = process.env.MCP_STATE_SECRET || process.env.JWT_SECRET || '';
  if (s.length < 16) return null;
  return createHash('sha256').update('mcp-request-state:v1\0').update(s).digest();
}

/** Аргументы в одном виде независимо от порядка ключей. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

function argsDigest(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(isObj(args) ? args : {}))).digest('base64url').slice(0, 22);
}

interface StatePayload { v: 1; tool: string; args: string; tok: string; exp: number }

export function sealRequestState(p: { tool: string; args: unknown; token: string; nowMs?: number }): string | null {
  const key = stateKey();
  if (!key) return null;
  const payload: StatePayload = {
    v: 1, tool: p.tool, args: argsDigest(p.args), tok: p.token,
    exp: (p.nowMs ?? Date.now()) + PENDING_REQUEST_TTL_MIN * 60_000,
  };
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export type StateCheck =
  | { ok: true; token: string }
  | { ok: false; reason: 'forged' | 'expired' | 'mismatch' };

export function openRequestState(state: unknown, tool: string, args: unknown, nowMs: number = Date.now()): StateCheck {
  const key = stateKey();
  if (!key || typeof state !== 'string' || state.length > 2048) return { ok: false, reason: 'forged' };
  let payload: unknown;
  try {
    const raw = Buffer.from(state, 'base64url');
    if (raw.length < 12 + 16 + 2) return { ok: false, reason: 'forged' };
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    payload = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return { ok: false, reason: 'forged' };
  }
  if (!isObj(payload) || payload.v !== 1 || typeof payload.exp !== 'number') return { ok: false, reason: 'forged' };
  const tok = payload.tok;
  if (!isPendingToken(tok)) return { ok: false, reason: 'forged' };
  if (nowMs > payload.exp) return { ok: false, reason: 'expired' };
  if (payload.tool !== tool || payload.args !== argsDigest(args)) return { ok: false, reason: 'mismatch' };
  return { ok: true, token: tok };
}

/** Токен черновика из ссылки на /confirm (он во фрагменте адреса). */
export function tokenOfConfirmUrl(url: string): string | null {
  const i = url.indexOf('#');
  const t = i >= 0 ? url.slice(i + 1) : '';
  return isPendingToken(t) ? t : null;
}

/**
 * `InputRequiredResult` вместо текстового черновика. null — запечатать нечем
 * или ссылка не наша: вызывающий отдаёт прежний ответ.
 */
export function sendInputRequired(p: { tool: string; args: unknown; confirmUrl: string; nowMs?: number }): Record<string, unknown> | null {
  const token = tokenOfConfirmUrl(p.confirmUrl);
  if (!token) return null;
  const requestState = sealRequestState({ tool: p.tool, args: p.args, token, nowMs: p.nowMs });
  if (!requestState) return null;
  return {
    resultType: 'input_required',
    inputRequests: {
      [SEND_INPUT_KEY]: {
        method: 'elicitation/create',
        params: { mode: 'url', url: confirmPageUrl(token), message: SEND_ELICITATION_MESSAGE },
      },
    },
    requestState,
  };
}

/** Что человек ответил на окно: accept / decline / cancel; ничего — как cancel. */
export function sendAction(params: Record<string, unknown>): 'accept' | 'decline' | 'cancel' {
  const responses = params.inputResponses;
  const r = isObj(responses) ? responses[SEND_INPUT_KEY] : undefined;
  const a = isObj(r) ? r.action : undefined;
  return a === 'accept' || a === 'decline' ? a : 'cancel';
}

export type RetryAnswer =
  | { kind: 'result'; text: string; isError?: true; structured: Record<string, unknown> }
  | { kind: 'state_refused'; message: string };

const NONE_ACCEPTED = { test: false, accepted: 0, requests: [] as unknown[] };

/**
 * Повтор `tools/call` после окна: инструмент не исполняется заново, черновик
 * читается по токену из `requestState`. Тексты — для модели.
 */
export async function answerSendRetry(p: { tool: string; args: unknown; params: Record<string, unknown>; nowMs?: number }): Promise<RetryAnswer> {
  const st = openRequestState(p.params.requestState, p.tool, p.args, p.nowMs);
  if (!st.ok) {
    return {
      kind: 'state_refused',
      message: st.reason === 'expired'
        ? `Invalid params: requestState истёк (черновик живёт ${PENDING_REQUEST_TTL_MIN} мин). Вызови инструмент заново без requestState`
        : 'Invalid params: requestState не прошёл проверку или не от этого вызова (другой инструмент или аргументы). Вызови инструмент заново без requestState',
    };
  }
  const url = confirmPageUrl(st.token);
  const read = await readPendingRequest(st.token);
  switch (read.kind) {
    case 'sent':
      return {
        kind: 'result',
        text: 'Заявка отправлена: человек сам нажал «Отправить» на странице Ведара. Ссылку на её состояние страница показала ему; '
          + 'ключа статуса у тебя нет — не выдумывай его. Это не бронь: подтверждает исполнитель.',
        structured: { ...NONE_ACCEPTED },
      };
    case 'expired':
    case 'missing':
      return {
        kind: 'result',
        text: `Черновик заявки истёк (${PENDING_REQUEST_TTL_MIN} мин) — заявка НЕ отправлена и никому не передана. Если человек всё ещё хочет её отправить, вызови инструмент заново.`,
        structured: { ...NONE_ACCEPTED },
      };
    case 'failed':
      return {
        kind: 'result',
        isError: true,
        text: 'Не удалось проверить черновик заявки — это сбой на стороне Ведара. Отправлена ли заявка, сказать нельзя; повтори позже.',
        structured: { ...NONE_ACCEPTED },
      };
    case 'found': {
      const action = sendAction(p.params);
      const confirmation = { confirmation: { url, expires_in_min: PENDING_REQUEST_TTL_MIN } };
      if (action === 'decline') {
        return {
          kind: 'result',
          text: `${read.draftText}\n\nЧеловек отказался открывать страницу отправки — заявка НЕ отправлена и никому не передана. Не настаивай; черновик сам удалится через ${PENDING_REQUEST_TTL_MIN} мин.`,
          structured: { ...NONE_ACCEPTED },
        };
      }
      const lead = action === 'accept'
        ? 'Человек открыл страницу Ведара, но «Отправить» ещё не нажал — заявка пока НЕ отправлена.'
        : 'Человек закрыл окно, не открыв страницу, — заявка НЕ отправлена.';
      return {
        kind: 'result',
        text: `${read.draftText}\n\n${lead} ${askHumanToSend(url)}`,
        structured: { ...NONE_ACCEPTED, ...confirmation },
      };
    }
  }
}
