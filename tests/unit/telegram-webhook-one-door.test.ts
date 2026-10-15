/**
 * Вебхук бота Telegram ставит одна дверь — setCanonicalWebhook (аудит 15.10).
 *
 * До этого адрес ставили шесть мест: сторож вебхука — на /api/telegram/webhook
 * с секретом, а кнопка «Подключить» в админке, роут и страница диагностики и
 * два ручных роута — на /api/telegram/kuzmich без секрета. Бот один, адрес у
 * него один: кто нажал последним, тот и прав. После P3-03 обработчик без
 * секрета отвечает 503, и такая кнопка глушила бы бота до прогона сторожа.
 *
 * Проверяется вызовом каждого установщика: адрес — главный, секрет передан;
 * без секрета Telegram не зовётся вовсе. Регулярка — только запрет: прямой
 * вызов setWebhook вне двери (бот-репостер — отдельный бот со своим токеном).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: async () => ({ userId: 'admin-1', role: 'admin' }),
}));
vi.mock('@/lib/platform-settings', () => ({
  getSetting: async () => null,
  setSetting: async () => undefined,
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: async () => ({ rows: [] }) } }));

const CANONICAL = 'https://vedarai.ru/api/telegram/webhook';

type Call = { method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let currentWebhookUrl = '';

function stubTelegram() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const method = String(url).split('/').pop() ?? '';
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ method, body });
    if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { username: 'kuzmichai_bot', first_name: 'Кузьмич' } }));
    if (method === 'getWebhookInfo') return new Response(JSON.stringify({ ok: true, result: { url: currentWebhookUrl, pending_update_count: 0 } }));
    return new Response(JSON.stringify({ ok: true, result: true }));
  }));
}

const setWebhookCalls = () => calls.filter(c => c.method === 'setWebhook');

beforeEach(() => {
  vi.resetModules();
  calls = [];
  currentWebhookUrl = 'https://vedarai.ru/api/telegram/kuzmich';
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'whsec';
  process.env.TELEGRAM_WEBHOOK_URL = 'https://vedarai.ru';
  process.env.CRON_SECRET = 'cron';
  stubTelegram();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

function expectCanonical(c: Call | undefined) {
  expect(c, 'setWebhook не вызван').toBeDefined();
  expect(c!.body?.url).toBe(CANONICAL);
  expect(c!.body?.secret_token).toBe('whsec');
}

describe('setCanonicalWebhook — дверь', () => {
  it('ставит главный адрес с секретом', async () => {
    const { setCanonicalWebhook } = await import('@/lib/telegram/operator-availability');
    const r = await setCanonicalWebhook('tok');
    expect(r).toEqual({ ok: true, url: CANONICAL });
    expectCanonical(setWebhookCalls()[0]);
  });

  it('без секрета Telegram не зовётся, причина названа', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { setCanonicalWebhook } = await import('@/lib/telegram/operator-availability');
    const r = await setCanonicalWebhook('tok');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('TELEGRAM_WEBHOOK_SECRET');
    expect(setWebhookCalls()).toHaveLength(0);
  });

  it('отказ Telegram — не «ок», а его описание', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: bad webhook' }))));
    const { setCanonicalWebhook } = await import('@/lib/telegram/operator-availability');
    const r = await setCanonicalWebhook('tok');
    expect(r).toEqual({ ok: false, url: CANONICAL, error: 'Bad Request: bad webhook' });
  });
});

describe('установщики идут через дверь', () => {
  it('кнопка «Подключить» в админке (POST /api/admin/telegram)', async () => {
    const { POST } = await import('@/app/api/admin/telegram/route');
    const res = await POST(new Request('https://vedarai.ru/api/admin/telegram', {
      method: 'POST', body: JSON.stringify({ reregister: true }),
    }) as never);
    expect(res.status).toBe(200);
    expectCanonical(setWebhookCalls()[0]);
  });

  it('кнопка админки без секрета — 400, вебхук не тронут', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { POST } = await import('@/app/api/admin/telegram/route');
    const res = await POST(new Request('https://vedarai.ru/api/admin/telegram', {
      method: 'POST', body: JSON.stringify({ reregister: true }),
    }) as never);
    expect(res.status).toBe(400);
    expect(setWebhookCalls()).toHaveLength(0);
  });

  it('диагностика переводит бота с запасного адреса на главный', async () => {
    const { GET } = await import('@/app/api/admin/telegram/diagnose/route');
    const res = await GET(new Request('https://vedarai.ru/api/admin/telegram/diagnose') as never);
    const body = await res.json() as { webhook_fixed: boolean; expected_url: string };
    expect(body.webhook_fixed).toBe(true);
    expect(body.expected_url).toBe(CANONICAL);
    expectCanonical(setWebhookCalls()[0]);
  });

  it('диагностика не трогает бота, если адрес уже главный', async () => {
    currentWebhookUrl = CANONICAL;
    const { GET } = await import('@/app/api/admin/telegram/diagnose/route');
    await GET(new Request('https://vedarai.ru/api/admin/telegram/diagnose') as never);
    expect(setWebhookCalls()).toHaveLength(0);
  });

  it('setup-webhook с { bot: "kuzmich" } — тот же главный адрес', async () => {
    const { POST } = await import('@/app/api/telegram/setup-webhook/route');
    const res = await POST(new Request('https://vedarai.ru/api/telegram/setup-webhook', {
      method: 'POST', headers: { 'x-cron-secret': 'cron' },
      body: JSON.stringify({ bot: 'kuzmich', appUrl: 'https://evil.example' }),
    }) as never);
    expect(res.status).toBe(200);
    expectCanonical(setWebhookCalls()[0]);
  });

  it('register-kuzmich — тот же главный адрес', async () => {
    const { GET } = await import('@/app/api/telegram/register-kuzmich/route');
    const res = await GET(new Request('https://vedarai.ru/api/telegram/register-kuzmich', {
      headers: { authorization: 'Bearer cron' },
    }) as never);
    expect(res.status).toBe(200);
    expectCanonical(setWebhookCalls()[0]);
  });

  it('register-kuzmich без секрета крона — 403, вебхук не тронут', async () => {
    const { GET } = await import('@/app/api/telegram/register-kuzmich/route');
    const res = await GET(new Request('https://vedarai.ru/api/telegram/register-kuzmich') as never);
    expect(res.status).toBe(403);
    expect(setWebhookCalls()).toHaveLength(0);
  });

  it('сторож вебхука восстанавливает тем же адресом', async () => {
    const { checkAndRestoreWebhook } = await import('@/lib/telegram/operator-availability');
    const r = await checkAndRestoreWebhook({ previous: null });
    expect(r.status).toBe('restored');
    expectCanonical(setWebhookCalls()[0]);
  });
});

describe('запрет: setWebhook вне двери', () => {
  const ROOT = process.cwd();
  const ALLOWED = new Set([
    'lib/telegram/operator-availability.ts',
    // Бот-репостер — отдельный бот (REPOSTER_TG_BOT_TOKEN) со своим обработчиком.
    'app/api/bots/reposter/setup/route.ts',
  ]);
  function walk(dir: string, out: string[]) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
  }

  it('прямого вызова setWebhook нет ни в app/, ни в lib/', () => {
    const files: string[] = [];
    walk(join(ROOT, 'app'), files);
    walk(join(ROOT, 'lib'), files);
    const offenders = files
      .map(f => relative(ROOT, f))
      .filter(f => !ALLOWED.has(f))
      .filter(f => /setWebhook`|['"]setWebhook['"]/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
