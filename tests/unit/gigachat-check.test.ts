// @vitest-environment node
/**
 * /api/cron/gigachat-check — проверка ключа GigaChat с прода.
 * Ключ и токен в ответах и логах не должны появляться; TLS не отключаем.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { RUSSIAN_TRUSTED_ROOT_CA_PEM } from '@/lib/gigachat/ca';
import { createSberHttpsAgent, CHAT_URL, OAUTH_URL } from '@/lib/gigachat/client';
import {
  clampQuestion,
  DEFAULT_QUESTION,
  extractAnswer,
  extractText,
  extractUsage,
  MAX_QUESTION_LENGTH,
  mentionsVedar,
  redact,
  VEDAR_RE,
} from '@/lib/gigachat/parse';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/cron/gigachat-check/route.ts'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'lib/gigachat/client.ts'), 'utf8');
const CERT = readFileSync(join(ROOT, 'certs/russian_trusted_root_ca_pem.crt'), 'utf8');
const NEXT_CONFIG = readFileSync(join(ROOT, 'next.config.js'), 'utf8');
const routeCode = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('сертификат НУЦ в сборке', () => {
  it('встроенный PEM совпадает с файлом в репозитории', () => {
    expect(RUSSIAN_TRUSTED_ROOT_CA_PEM.trim()).toBe(CERT.trim());
    expect(RUSSIAN_TRUSTED_ROOT_CA_PEM).toContain('BEGIN CERTIFICATE');
  });

  it('standalone-трассировка включает файл сертификата', () => {
    expect(NEXT_CONFIG).toContain('./certs/russian_trusted_root_ca_pem.crt');
  });
});

describe('разбор ответа, как в measure_gigachat.py', () => {
  it('достаёт текст из choices[].message.content', () => {
    expect(
      extractAnswer({
        choices: [{ message: { role: 'assistant', content: 'Возьмите термос и дождевик.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }),
    ).toBe('Возьмите термос и дождевик.');
  });

  it('достаёт текст из messages[0] и из массива частей', () => {
    expect(extractAnswer({ messages: [{ content: 'Первый вариант.' }] })).toBe('Первый вариант.');
    expect(
      extractText({
        content: [{ type: 'text', text: 'Часть А. ' }, { content: 'Часть Б.' }],
      }),
    ).toBe('Часть А. Часть Б.');
  });

  it('достаёт usage и не путает его с пустым объектом', () => {
    expect(extractUsage({ usage: { total_tokens: 21 } })).toEqual({ total_tokens: 21 });
    expect(extractUsage({ usage: {} })).toBeNull();
    expect(extractUsage({})).toBeNull();
  });

  it('mentionsVedar ловит vedarai и ведар, регистр не важен', () => {
    expect(mentionsVedar('Смотрите https://vedarai.ru/chto-vzyat-s-soboj-na-kamchatku')).toBe(true);
    expect(mentionsVedar('На платформе Ведар есть список вещей.')).toBe(true);
    expect(mentionsVedar('VEDARAI пишет про слой одежды.')).toBe(true);
    expect(mentionsVedar('На Камчатке возьмите термос и дождевик.')).toBe(false);
    expect(VEDAR_RE.source).toBe('vedarai|ведар');
  });

  it('redact вырезает токены и не оставляет их в копии', () => {
    const raw = {
      access_token: 'fake-token',
      Authorization: 'Bearer abc',
      choices: [{ message: { content: 'ок' } }],
    };
    const cleaned = redact(raw) as Record<string, unknown>;
    expect(cleaned.access_token).toBe('[redacted]');
    expect(cleaned.Authorization).toBe('[redacted]');
    expect(JSON.stringify(cleaned)).not.toMatch(/fake-token|Bearer abc/);
    expect(raw.access_token).toBe('fake-token');
  });

  it('пустой вопрос заменяется дефолтным, длинный обрезается', () => {
    expect(clampQuestion('')).toBe(DEFAULT_QUESTION);
    expect(clampQuestion('   ')).toBe(DEFAULT_QUESTION);
    expect(clampQuestion('когда ехать на Камчатку')).toBe('когда ехать на Камчатку');
    expect(clampQuestion('я'.repeat(MAX_QUESTION_LENGTH + 20))).toHaveLength(MAX_QUESTION_LENGTH);
  });
});

describe('TLS-агент не отключает проверку', () => {
  it('https.Agent с корнем НУЦ и rejectUnauthorized: true', () => {
    const agent = createSberHttpsAgent();
    expect(agent).toBeInstanceOf(https.Agent);
    const opts = agent.options;
    expect(opts.rejectUnauthorized).toBe(true);
    const ca = opts.ca;
    const list = Array.isArray(ca) ? ca : [ca];
    expect(list.some((item) => String(item).includes(RUSSIAN_TRUSTED_ROOT_CA_PEM.trim()))).toBe(true);
  });

  it('в клиенте и роуте нет отключения TLS', () => {
    expect(CLIENT).toContain('rejectUnauthorized: true');
    expect(CLIENT).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(routeCode).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(CLIENT).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe('роут: доступ раньше вызова, секреты не светятся', () => {
  it('экспортирует GET и POST, закрыт verifyCronSecret, 401 объясняет себя', () => {
    expect(ROUTE).toMatch(/export async function GET/);
    expect(ROUTE).toMatch(/export async function POST/);
    expect(routeCode).toContain('verifyCronSecret');
    expect(routeCode).toContain('diagnoseCronAuth');
    const authAt = routeCode.indexOf('verifyCronSecret');
    const callAt = routeCode.indexOf('runGigachatCheck');
    expect(authAt).toBeGreaterThan(0);
    expect(callAt).toBeGreaterThan(authAt);
  });

  it('секрет не читается из query в роуте, ключ в логах не пишется', () => {
    expect(routeCode).not.toMatch(/searchParams\.get\(\s*['"]secret['"]\s*\)/);
    expect(CLIENT).not.toMatch(/console\.(log|info|debug|error|warn)\([^)]*(Authorization|GIGACHAT_CREDENTIALS|access_token)/);
    expect(routeCode).not.toMatch(/console\.(log|info|debug|error|warn)/);
  });

  it('ходит на официальные URL Сбера и не форсит web_search', () => {
    expect(OAUTH_URL).toBe('https://ngw.devices.sberbank.ru:9443/api/v2/oauth');
    expect(CHAT_URL).toBe('https://gigachat.devices.sberbank.ru/api/v1/chat/completions');
    expect(CLIENT).toContain("scope=GIGACHAT_API_PERS");
    expect(CLIENT).not.toMatch(/web_search|tool_config/);
  });
});

describe('runGigachatCheck: ошибки без секретов, успех с mentionsVedar', () => {
  const originalCreds = process.env.GIGACHAT_CREDENTIALS;
  const originalKey = process.env.GIGACHAT_AUTH_KEY;

  beforeEach(() => {
    delete process.env.GIGACHAT_CREDENTIALS;
    delete process.env.GIGACHAT_AUTH_KEY;
  });

  afterEach(() => {
    if (originalCreds === undefined) delete process.env.GIGACHAT_CREDENTIALS;
    else process.env.GIGACHAT_CREDENTIALS = originalCreds;
    if (originalKey === undefined) delete process.env.GIGACHAT_AUTH_KEY;
    else process.env.GIGACHAT_AUTH_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('без ключа возвращает credentials_unset и никуда не ходит', async () => {
    const spy = vi.spyOn(https, 'request');
    const { runGigachatCheck } = await import('@/lib/gigachat/client');
    const result = await runGigachatCheck(DEFAULT_QUESTION);
    expect(result).toEqual({
      status: 503,
      body: { ok: false, probe: 'gigachat_check_v1', error: 'credentials_unset' },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('успешный ответ содержит модель, текст, usage и mentionsVedar, без токена', async () => {
    process.env.GIGACHAT_CREDENTIALS = 'fake-key';
    mockHttpsSequence([
      {
        status: 200,
        data: { access_token: 'fake-token', expires_at: 1 },
      },
      {
        status: 200,
        data: {
          choices: [
            {
              message: {
                content: 'Список вещей есть на vedarai.ru/chto-vzyat-s-soboj-na-kamchatku',
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
        },
      },
    ]);
    const { runGigachatCheck } = await import('@/lib/gigachat/client');
    const result = await runGigachatCheck(DEFAULT_QUESTION);
    expect(result.status).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.model).toBe('GigaChat');
    expect(result.body.mentionsVedar).toBe(true);
    expect(result.body.answer).toContain('vedarai.ru');
    expect(result.body.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 40,
      total_tokens: 52,
    });
    const dumped = JSON.stringify(result);
    expect(dumped).not.toMatch(/fake-token|fake-key/);
  });

  it('отказ OAuth отдаёт только http_status, без тела с токеном', async () => {
    process.env.GIGACHAT_CREDENTIALS = 'fake-key';
    mockHttpsSequence([
      { status: 401, data: { access_token: 'noleak', message: 'nope' } },
    ]);
    const { runGigachatCheck } = await import('@/lib/gigachat/client');
    const result = await runGigachatCheck(DEFAULT_QUESTION);
    expect(result).toEqual({
      status: 502,
      body: { ok: false, probe: 'gigachat_check_v1', error: 'oauth_failed', http_status: 401 },
    });
    expect(JSON.stringify(result)).not.toMatch(/noleak|nope|fake-key/);
  });
});

function mockHttpsSequence(replies: Array<{ status: number; data: unknown }>) {
  let i = 0;
  vi.spyOn(https, 'request').mockImplementation(((
    _urlOrOpts: unknown,
    cbOrOpts?: unknown,
    maybeCb?: unknown,
  ) => {
    const cb = typeof cbOrOpts === 'function' ? cbOrOpts : maybeCb;
    const reply = replies[i] ?? replies[replies.length - 1];
    i += 1;
    const handlers: Record<string, Function> = {};
    const req = {
      setTimeout: () => req,
      on: (event: string, fn: Function) => {
        handlers[event] = fn;
        return req;
      },
      write: () => true,
      end: () => {
        const res = {
          statusCode: reply.status,
          on: (event: string, fn: Function) => {
            if (event === 'data') fn(Buffer.from(JSON.stringify(reply.data), 'utf8'));
            if (event === 'end') fn();
            return res;
          },
        };
        if (typeof cb === 'function') cb(res);
        return req;
      },
      destroy: () => req,
    };
    return req;
  }) as typeof https.request);
}
