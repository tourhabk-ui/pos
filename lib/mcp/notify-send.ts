/**
 * Отправка уведомления агенту: подпись Standard Webhooks и один POST на адрес,
 * который выбрал чужой человек (29.10).
 *
 * ── Подпись ────────────────────────────────────────────────────────────────
 * Standard Webhooks (https://www.standardwebhooks.com): заголовки webhook-id,
 * webhook-timestamp (секунды Unix) и webhook-signature
 * `v1,<base64(HMAC-SHA256(ключ, "id.timestamp.тело"))>`, ключ — base64 после
 * `whsec_`. Защита от повтора — на стороне приёмника: допуск по метке времени
 * и дедупликация по id; это сказано агенту в ответе инструмента.
 *
 * ── Защита соединения ──────────────────────────────────────────────────────
 * - форма адреса проверяется заново (checkNotifyUrlShape) и IP-литерал
 *   отвергается ДО https.request: при литерале Node не зовёт lookup, и
 *   проверка адреса при соединении ничего бы не проверила (критика
 *   безопасности 29.10);
 * - имя разрешается своим резолвером с таймаутом (resolvePublic), все адреса
 *   должны быть публичными, и сокету через lookup отдаются РОВНО они: проверка
 *   и соединение — один ответ DNS, окна для rebinding нет;
 * - один абсолютный срок на всю попытку — DNS, TCP, TLS и заголовки ответа;
 *   по нему req.destroy(). Таймаут простоя сокета тут не годится: приёмник,
 *   присылающий по байту раз в несколько секунд, держал бы его бесконечно;
 * - тело ответа не читается, редиректам не следуем (3xx — свой исход);
 * - TLS проверяется (rejectUnauthorized: true явно — не зависим от
 *   NODE_TLS_REJECT_UNAUTHORIZED окружения), своих корней нет; agent: false —
 *   без пула и без прокси окружения.
 *
 * Исход — только машинный код (`^[a-z0-9_]{1,40}$`): ни адреса, ни текста
 * ошибки Node (в нём бывает хост и IP) наружу и в базу не уходит.
 */

import { createHmac } from 'node:crypto';
import https, { type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { checkNotifyUrlShape } from '@/lib/security/notify-url-shape';
import { resolvePublic, type PublicResolver, type ResolvedAddress } from '@/lib/security/public-address';

export const NOTIFY_USER_AGENT = 'VedarNotify/1.0 (+https://vedarai.ru/mcp)';

/** Весь обмен одной попытки — DNS, соединение, TLS, заголовки ответа. */
export const SEND_TOTAL_MS = 10_000;

/** base64 HMAC-SHA256 по Standard Webhooks; ключ — base64-часть после `whsec_`. */
export function signWebhook(signingKey: string, id: string, timestampSec: number, body: string): string {
  const key = Buffer.from(signingKey.startsWith('whsec_') ? signingKey.slice('whsec_'.length) : signingKey, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampSec}.${body}`, 'utf8').digest('base64')}`;
}

/**
 * Исход попытки:
 * - delivered — 2xx;
 * - gone — 410: приёмник просит больше не слать;
 * - rejected — 4xx, который повтор не исправит (всё, кроме 408, 425, 429):
 *   адрес не приёмник — отключаем с первого ответа, чтобы чужой адрес получал
 *   не больше одного запроса на подписку;
 * - retry — всё прочее (3xx, 408/425/429, 5xx, сеть, TLS, DNS, отказ адреса):
 *   повтор по графику. `network: true` — до HTTP-ответа не дошло.
 */
export type SendOutcome =
  | { kind: 'delivered'; code: string }
  | { kind: 'gone'; code: 'http_410' }
  | { kind: 'rejected'; code: string }
  | { kind: 'retry'; code: string; network: boolean };

export type SendFn = (url: string, body: string, headers: Record<string, string>) => Promise<SendOutcome>;

export interface SendDeps {
  resolver?: PublicResolver;
  /** Подменяется в тестах; по умолчанию node:https request. */
  request?: (options: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest;
  totalMs?: number;
}

const RETRY_4XX = new Set([408, 425, 429]);

export function outcomeOfStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return { kind: 'delivered', code: `http_${status}` };
  if (status === 410) return { kind: 'gone', code: 'http_410' };
  if (status >= 300 && status < 400) return { kind: 'retry', code: `redirect_${status}`, network: false };
  if (status >= 400 && status < 500 && !RETRY_4XX.has(status)) return { kind: 'rejected', code: `http_${status}` };
  return { kind: 'retry', code: `http_${Number.isInteger(status) && status > 0 && status < 1000 ? status : 0}`, network: false };
}

/** Код сетевой ошибки Node → машинный исход; текст ошибки не нужен и не берётся. */
export function networkCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const c = typeof code === 'string' ? code : '';
  if (c === 'ETIMEDOUT' || c === 'VEDAR_DEADLINE') return 'timeout';
  if (c === 'ECONNREFUSED') return 'refused';
  if (c === 'ECONNRESET' || c === 'EPIPE') return 'reset';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'unreachable';
  if (c.startsWith('ERR_TLS') || c.startsWith('ERR_SSL') || c.startsWith('CERT_') || c.includes('CERT')
      || c === 'DEPTH_ZERO_SELF_SIGNED_CERT' || c === 'SELF_SIGNED_CERT_IN_CHAIN' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'tls';
  return 'network';
}

/** lookup, отдающий сокету только уже проверенные адреса. */
export function pinnedLookup(host: string, addresses: ResolvedAddress[]) {
  return (hostname: string, options: { all?: boolean } | number | undefined,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void => {
    if (hostname.toLowerCase() !== host || addresses.length === 0) {
      callback(Object.assign(new Error('адрес не проверен'), { code: 'ENOTPUBLIC' }), '', 0);
      return;
    }
    if (typeof options === 'object' && options?.all) {
      callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  };
}

/**
 * Один POST с подписью, уже посчитанной вызывающим. Никогда не бросает:
 * любой сбой — исход с кодом.
 */
export async function postSigned(rawUrl: string, body: string, headers: Record<string, string>, deps: SendDeps = {}): Promise<SendOutcome> {
  const started = Date.now();
  const total = deps.totalMs ?? SEND_TOTAL_MS;
  const shape = checkNotifyUrlShape(rawUrl);
  // Правила формы могли ужесточиться после создания подписки — тогда адрес не
  // принимается, как и при создании. Исход тот же, что у внутреннего адреса:
  // по нему снаружи нельзя различить, что именно не понравилось.
  if (!shape.ok) return { kind: 'retry', code: 'address_refused', network: true };
  const host = shape.host;
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return { kind: 'retry', code: 'address_refused', network: true };

  const resolved = await resolvePublic(host, { resolver: deps.resolver, timeoutMs: Math.min(total, 3000) });
  if (!resolved.ok) return { kind: 'retry', code: resolved.code, network: true };

  const remaining = total - (Date.now() - started);
  if (remaining <= 0) return { kind: 'retry', code: 'timeout', network: true };
  const doRequest = deps.request ?? ((options: RequestOptions, cb: (res: IncomingMessage) => void) => https.request(options, cb));

  return new Promise<SendOutcome>((resolve) => {
    let settled = false;
    const clock: { timer?: NodeJS.Timeout } = {};
    const finish = (o: SendOutcome) => { if (!settled) { settled = true; if (clock.timer) clearTimeout(clock.timer); resolve(o); } };
    let req: ClientRequest;
    try {
      req = doRequest({
        method: 'POST',
        host,
        servername: host,
        port: 443,
        path: `${shape.url.pathname}${shape.url.search}`,
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body, 'utf8')) },
        lookup: pinnedLookup(host, resolved.addresses) as unknown as RequestOptions['lookup'],
        agent: false,
        rejectUnauthorized: true,
      }, (res) => {
        const status = res.statusCode ?? 0;
        // Тело не нужно: статуса достаточно. Сокет закрывается сразу.
        res.destroy();
        req.destroy();
        finish(outcomeOfStatus(status));
      });
    } catch (err) {
      finish({ kind: 'retry', code: networkCode(err), network: true });
      return;
    }
    clock.timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('срок попытки истёк'), { code: 'VEDAR_DEADLINE' }));
      finish({ kind: 'retry', code: 'timeout', network: true });
    }, remaining);
    req.on('error', (err) => finish({ kind: 'retry', code: networkCode(err), network: true }));
    req.end(body);
  });
}
