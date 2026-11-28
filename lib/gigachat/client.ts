/**
 * Клиент Freemium API GigaChat: OAuth + одно chat/completions.
 * TLS проверяется: https.Agent с корнем НУЦ Минцифры и стандартным
 * хранилищем Node. rejectUnauthorized не отключаем.
 * Ключ и access_token не логируются и в ошибки не попадают.
 */
import https from 'node:https';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { RUSSIAN_TRUSTED_ROOT_CA_PEM } from '@/lib/gigachat/ca';
import {
  DEFAULT_MODEL,
  extractAnswer,
  extractUsage,
  mentionsVedar,
  type GigachatUsage,
} from '@/lib/gigachat/parse';

export const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

const OAUTH_TIMEOUT_MS = 30_000;
const CHAT_TIMEOUT_MS = 90_000;

export function createSberHttpsAgent(): https.Agent {
  return new https.Agent({
    ca: [...tls.rootCertificates, RUSSIAN_TRUSTED_ROOT_CA_PEM],
    rejectUnauthorized: true,
  });
}

export type GigachatCheckOk = {
  ok: true;
  probe: 'gigachat_check_v1';
  model: string;
  question: string;
  answer: string;
  mentionsVedar: boolean;
  usage: GigachatUsage | null;
};

export type GigachatCheckErr = {
  ok: false;
  probe: 'gigachat_check_v1';
  error: string;
  http_status?: number;
};

export type GigachatCheckResult =
  | { status: number; body: GigachatCheckOk }
  | { status: number; body: GigachatCheckErr };

type JsonResponse = { status: number; data: unknown };

class HttpTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'HttpTimeoutError';
  }
}

function isTlsError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; name?: string };
  const code = (e.code ?? '').toUpperCase();
  const msg = (e.message ?? '').toUpperCase();
  return (
    code.includes('CERT') ||
    code.includes('SSL') ||
    code.includes('TLS') ||
    msg.includes('CERTIFICATE') ||
    msg.includes('SSL') ||
    msg.includes('TLS') ||
    msg.includes('UNABLE_TO_VERIFY')
  );
}

function requestJson(
  url: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string | Buffer;
    timeoutMs: number;
    agent: https.Agent;
  },
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string | number> = { ...opts.headers };
    if (opts.body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(opts.body);
    }
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        headers,
        agent: opts.agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: unknown = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new HttpTimeoutError());
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function credentials(): string | null {
  const value = (process.env.GIGACHAT_CREDENTIALS || process.env.GIGACHAT_AUTH_KEY || '').trim();
  return value || null;
}

function modelName(): string {
  return (process.env.GIGACHAT_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

/**
 * Один вопрос к API без поиска в сети: в справке Сбера у Freemium API
 * его нет, а принудительный инструмент ломал бы проверку ключа.
 */
export async function runGigachatCheck(question: string): Promise<GigachatCheckResult> {
  const key = credentials();
  if (!key) {
    return { status: 503, body: { ok: false, probe: 'gigachat_check_v1', error: 'credentials_unset' } };
  }

  const agent = createSberHttpsAgent();
  let token: string;
  try {
    const oauth = await requestJson(OAUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: randomUUID(),
        Authorization: `Basic ${key}`,
      },
      body: 'scope=GIGACHAT_API_PERS',
      timeoutMs: OAUTH_TIMEOUT_MS,
      agent,
    });
    const access =
      oauth.data && typeof oauth.data === 'object'
        ? (oauth.data as Record<string, unknown>).access_token
        : null;
    if (oauth.status !== 200 || typeof access !== 'string' || !access) {
      return {
        status: 502,
        body: { ok: false, probe: 'gigachat_check_v1', error: 'oauth_failed', http_status: oauth.status },
      };
    }
    token = access;
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      return { status: 504, body: { ok: false, probe: 'gigachat_check_v1', error: 'oauth_timeout' } };
    }
    if (isTlsError(err)) {
      return { status: 502, body: { ok: false, probe: 'gigachat_check_v1', error: 'oauth_tls' } };
    }
    return { status: 502, body: { ok: false, probe: 'gigachat_check_v1', error: 'oauth_network' } };
  }

  const model = modelName();
  try {
    const chat = await requestJson(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: question }],
      }),
      timeoutMs: CHAT_TIMEOUT_MS,
      agent,
    });
    if (chat.status !== 200) {
      return {
        status: 502,
        body: { ok: false, probe: 'gigachat_check_v1', error: 'chat_failed', http_status: chat.status },
      };
    }
    const answer = extractAnswer(chat.data).trim();
    const usage = extractUsage(chat.data);
    if (!answer) {
      return {
        status: 502,
        body: { ok: false, probe: 'gigachat_check_v1', error: 'empty_answer', http_status: 200 },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        probe: 'gigachat_check_v1',
        model,
        question,
        answer,
        mentionsVedar: mentionsVedar(answer),
        usage,
      },
    };
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      return { status: 504, body: { ok: false, probe: 'gigachat_check_v1', error: 'chat_timeout' } };
    }
    if (isTlsError(err)) {
      return { status: 502, body: { ok: false, probe: 'gigachat_check_v1', error: 'chat_tls' } };
    }
    return { status: 502, body: { ok: false, probe: 'gigachat_check_v1', error: 'chat_network' } };
  }
}
