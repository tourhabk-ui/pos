/**
 * Вебхуки Meta — Instagram/Messenger и WhatsApp — принимают только запрос,
 * подписанный секретом приложения (07.11, разбор вебхуков).
 *
 * До правки оба приёмника подпись X-Hub-Signature-256 не проверяли, хотя
 * `.env.example` обещал META_APP_SECRET «для валидации X-Hub-Signature-256»:
 * подделка с чужим отправителем вела Кузьмича и тратила модели. Сторож зовёт
 * сами роуты: подписанное доходит до Кузьмича, подделка, чужое тело и пустой
 * секрет — нет. Рукопожатие GET — только с нашим токеном.
 *
 * Плюс запрет: ни один роут API не запускает команды на сервере
 * (child_process). Единственный такой — выкат по вебхуку GitHub — удалён.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const brain = vi.hoisted(() => ({ processMessage: vi.fn(async () => undefined) }));
vi.mock('@/lib/kuzmich/core', () => ({ processMessage: brain.processMessage }));
vi.mock('@/lib/kuzmich/photo-vision', () => ({ describeKuzmichPhoto: vi.fn(async () => null) }));

import { verifyMetaSignature, metaHandshakeOk } from '@/lib/meta/webhook-signature';
import { GET as metaGet, POST as metaPost } from '@/app/api/meta/webhook/route';
import { GET as waGet, POST as waPost } from '@/app/api/whatsapp/kuzmich/route';

const SECRET = 'test-app-secret';

const META_BODY = {
  object: 'page',
  entry: [{ id: '1', messaging: [{ sender: { id: '1234567890' }, recipient: { id: '999' }, timestamp: 1, message: { mid: 'm1', text: 'Какие туры на вулкан?' } }] }],
};
const WA_BODY = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: {
    messages: [{ from: '70000000001', id: 'w1', type: 'text', text: { body: 'Какие туры на вулкан?' } }],
    contacts: [{ profile: { name: 'Тест' }, wa_id: '70000000001' }],
  } }] }],
};

/** Тело с пробелами и кириллицей: подпись считается по байтам, а не по пересобранному JSON. */
const rawOf = (body: unknown) => Buffer.from(JSON.stringify(body, null, 1), 'utf8');
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

function post(url: string, raw: Buffer, signature: string | null): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return new NextRequest(url, { method: 'POST', body: new Uint8Array(raw), headers });
}

const routes = [
  { name: 'Instagram/Messenger', url: 'http://localhost/api/meta/webhook', body: META_BODY, POST: metaPost },
  { name: 'WhatsApp', url: 'http://localhost/api/whatsapp/kuzmich', body: WA_BODY, POST: waPost },
] as const;

beforeEach(() => {
  brain.processMessage.mockClear();
  vi.stubEnv('META_APP_SECRET', SECRET);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(routes)('$name: подпись Meta до разбора тела', ({ url, body, POST }) => {
  it('подписанный секретом приложения — доходит до Кузьмича', async () => {
    const raw = rawOf(body);
    const res = await POST(post(url, raw, sign(raw)));
    expect(res.status).toBe(200);
    expect(brain.processMessage).toHaveBeenCalledTimes(1);
    expect(brain.processMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Какие туры на вулкан?' }));
  });

  it('подпись чужим секретом — 403, Кузьмич не зовётся', async () => {
    const raw = rawOf(body);
    const res = await POST(post(url, raw, sign(raw, 'someone-else')));
    expect(res.status).toBe(403);
    expect(brain.processMessage).not.toHaveBeenCalled();
  });

  it('без заголовка подписи — 403', async () => {
    const res = await POST(post(url, rawOf(body), null));
    expect(res.status).toBe(403);
    expect(brain.processMessage).not.toHaveBeenCalled();
  });

  it('подпись от другого тела — 403', async () => {
    const signedRaw = rawOf({ object: 'page', entry: [] });
    const res = await POST(post(url, rawOf(body), sign(signedRaw)));
    expect(res.status).toBe(403);
    expect(brain.processMessage).not.toHaveBeenCalled();
  });

  it('секрет приложения не задан — 503 «не настроено», а не «проверка пройдена»', async () => {
    vi.stubEnv('META_APP_SECRET', '');
    const raw = rawOf(body);
    const res = await POST(post(url, raw, sign(raw)));
    expect(res.status).toBe(503);
    expect(brain.processMessage).not.toHaveBeenCalled();
  });
});

describe('рукопожатие GET — только с нашим токеном', () => {
  const get = (url: string, token: string | null) => {
    const u = new URL(url);
    u.searchParams.set('hub.mode', 'subscribe');
    u.searchParams.set('hub.challenge', 'ch-42');
    if (token !== null) u.searchParams.set('hub.verify_token', token);
    return new NextRequest(u.toString());
  };

  it.each([
    ['Instagram/Messenger', 'http://localhost/api/meta/webhook', 'META_VERIFY_TOKEN', metaGet],
    ['WhatsApp', 'http://localhost/api/whatsapp/kuzmich', 'WHATSAPP_VERIFY_TOKEN', waGet],
  ] as const)('%s', async (_name, url, env, GET) => {
    vi.stubEnv(env, 'verify-me');
    const ok = await GET(get(url, 'verify-me'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ch-42');
    expect((await GET(get(url, 'verify-mE'))).status).toBe(403);
    expect((await GET(get(url, null))).status).toBe(403);
    vi.stubEnv(env, '');
    expect((await GET(get(url, ''))).status).toBe(403);
  });
});

describe('verifyMetaSignature', () => {
  it('три исхода: верная — ok, неверная — forbidden, нет секрета — not_configured', () => {
    const raw = Buffer.from('{"a":1}');
    expect(verifyMetaSignature(raw, sign(raw), SECRET)).toBe('ok');
    expect(verifyMetaSignature(raw, sign(raw).replace('sha256=', 'sha1='), SECRET)).toBe('forbidden');
    expect(verifyMetaSignature(raw, null, SECRET)).toBe('forbidden');
    expect(verifyMetaSignature(raw, sign(raw), undefined)).toBe('not_configured');
    expect(verifyMetaSignature(raw, sign(raw), '')).toBe('not_configured');
    expect(metaHandshakeOk('subscribe', 'x', 'c', 'x')).toBe(true);
    expect(metaHandshakeOk('unsubscribe', 'x', 'c', 'x')).toBe(false);
    expect(metaHandshakeOk('subscribe', 'x', null, 'x')).toBe(false);
  });
});

describe('запрет: роут API не запускает команды на сервере', () => {
  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...routeFiles(p));
      else if (/^route\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('ни один app/api/**/route.ts не импортирует child_process', () => {
    const files = routeFiles(join(process.cwd(), 'app', 'api'));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) => /['"](?:node:)?child_process['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
