// @vitest-environment node
// (jose подписывает JWT через WebCrypto — в jsdom его нет)
/**
 * Отзыв сессии доходит до /api/auth/me, /api/auth/state и серверных страниц
 * (аудит 15.10, P3-01).
 *
 * P1-фикс 28.08 сверял токен со строкой user_sessions в verifyAuth и
 * getUserFromRequest, но /api/auth/me — тот самый роут, который читает
 * AuthContext, — и /api/auth/state (шапка) сверяли только подпись. После
 * выхода подпись годна ещё до 7 дней: вышедший оставался «вошедшим» для
 * шапки, а утёкший токен продолжал отдавать email и имя. Так же — три
 * серверные страницы: планер, /hub/admin/safety и /hub/admin/telegram/webhook
 * (последняя при рендере сама зовёт setWebhook).
 *
 * Сторож судит поведение: настоящий подписанный токен, база отвечает про
 * строку сессии «есть» / «нет» / «упала» — и смотрим, что видит вызывающий.
 * Регулярка по исходнику здесь одна, и она — запрет: голый verifyToken вне
 * lib/auth (правило 13.10 допускает регулярку для «этого быть не должно»).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';

process.env.JWT_SECRET = 'test-secret-for-session-revocation';

type SessionRow = 'live' | 'revoked' | 'db-down';
let sessionRow: SessionRow = 'live';
const queryMock = vi.fn();

vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

let cookieToken: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'auth_token' && cookieToken ? { value: cookieToken } : undefined),
  }),
}));

class RedirectSignal extends Error {
  constructor(public to: string) { super(`redirect ${to}`); }
}
const redirectMock = vi.fn((to: string) => { throw new RedirectSignal(to); });
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirectMock(to),
}));

// Тяжёлые клиентские части страниц — заглушками: проверяется гейт, а не они.
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/app/planner/_PlannerClient', () => ({
  PlannerClient: ({ initialUserId }: { initialUserId?: string | null }) =>
    createElement('span', { 'data-user': initialUserId ?? 'guest' }),
}));
vi.mock('@/app/hub/admin/safety/SafetyDashboardClient', () => ({
  SafetyDashboardClient: () => createElement('span', null, 'safety-dashboard'),
}));
vi.mock('@/lib/platform-settings', () => ({ getSetting: async () => null }));

import { createToken } from '@/lib/auth/jwt';
import { GET as meGET } from '@/app/api/auth/me/route';
import { GET as stateGET } from '@/app/api/auth/state/route';
import PlannerPage from '@/app/planner/page';
import SafetyDashboard from '@/app/hub/admin/safety/page';
import TelegramWebhookPage from '@/app/hub/admin/telegram/webhook/page';

const USER = { userId: 'user-1', email: 'anna@example.ru', role: 'tourist' };
const ADMIN = { userId: 'admin-1', email: 'admin@example.ru', role: 'admin' };

beforeEach(() => {
  sessionRow = 'live';
  cookieToken = undefined;
  redirectMock.mockClear();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM user_sessions')) {
      if (sessionRow === 'db-down') throw new Error('connection terminated unexpectedly');
      return { rows: sessionRow === 'live' ? [{ id: 'session-1' }] : [] };
    }
    if (sql.includes('FROM users')) {
      return {
        rows: [{
          id: USER.userId, email: USER.email, name: 'Анна', role: 'tourist',
          preferences: {}, created_at: '2026-10-01', updated_at: '2026-10-01',
        }],
      };
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function req(path: string, opts: { cookie?: string; bearer?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = `auth_token=${opts.cookie}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest(`http://localhost${path}`, { headers });
}

const usersQueried = () => queryMock.mock.calls.some(([sql]) => String(sql).includes('FROM users'));

describe('/api/auth/me сверяет строку сессии, а не только подпись', () => {
  it('живая сессия — 200 и данные пользователя', async () => {
    const token = await createToken(USER);
    const res = await meGET(req('/api/auth/me', { cookie: token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe(USER.email);
  });

  it('отозванная сессия (cookie) — 401, ни email, ни имени, users не читается', async () => {
    const token = await createToken(USER);
    sessionRow = 'revoked';
    const res = await meGET(req('/api/auth/me', { cookie: token }));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(USER.email);
    expect(text).not.toContain('Анна');
    expect(usersQueried()).toBe(false);
  });

  it('отозванная сессия (Bearer из localStorage) — 401', async () => {
    const token = await createToken(USER);
    sessionRow = 'revoked';
    const res = await meGET(req('/api/auth/me', { bearer: token }));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(USER.email);
  });

  it('проверка сессии упала — 500 «не знаю», не данные и не 401', async () => {
    const token = await createToken(USER);
    sessionRow = 'db-down';
    const res = await meGET(req('/api/auth/me', { cookie: token }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(USER.email);
    expect(usersQueried()).toBe(false);
  });
});

describe('/api/auth/state: три исхода, и «вошёл» — это живая сессия', () => {
  async function state(token: string | undefined) {
    const res = await stateGET(req('/api/auth/state', token ? { cookie: token } : {}));
    return { status: res.status, body: await res.json() };
  }

  it('живая — true', async () => {
    const r = await state(await createToken(USER));
    expect(r).toMatchObject({ status: 200, body: { data: { authenticated: true } } });
  });

  it('отозванная — false (200, не 401)', async () => {
    const token = await createToken(USER);
    sessionRow = 'revoked';
    const r = await state(token);
    expect(r).toMatchObject({ status: 200, body: { data: { authenticated: false } } });
  });

  it('без токена — false', async () => {
    const r = await state(undefined);
    expect(r).toMatchObject({ status: 200, body: { data: { authenticated: false } } });
  });

  it('проверка сессии упала — 500, а не «гость»', async () => {
    const token = await createToken(USER);
    sessionRow = 'db-down';
    const r = await state(token);
    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
    expect(r.body.data).toBeUndefined();
  });
});

describe('серверные страницы сверяют строку сессии', () => {
  async function render(page: () => Promise<ReactNode>): Promise<string> {
    return renderToStaticMarkup(createElement('div', null, await page()));
  }

  it('планер: живая сессия — пользователь, отозванная и упавшая проверка — гость', async () => {
    cookieToken = await createToken(USER);
    expect(await render(PlannerPage)).toContain(`data-user="${USER.userId}"`);
    sessionRow = 'revoked';
    expect(await render(PlannerPage)).toContain('data-user="guest"');
    sessionRow = 'db-down';
    expect(await render(PlannerPage)).toContain('data-user="guest"');
  });

  it('/hub/admin/safety: живой админ проходит, отозванный — на вход', async () => {
    cookieToken = await createToken(ADMIN);
    expect(await render(SafetyDashboard)).toContain('safety-dashboard');
    expect(redirectMock).not.toHaveBeenCalled();

    sessionRow = 'revoked';
    await expect(SafetyDashboard()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirectMock).toHaveBeenCalledWith('/auth/login?from=/hub/admin/safety');
  });

  it('/hub/admin/safety: не смогли сверить сессию — не пускаем', async () => {
    cookieToken = await createToken(ADMIN);
    sessionRow = 'db-down';
    await expect(SafetyDashboard()).rejects.toBeInstanceOf(RedirectSignal);
  });

  it('/hub/admin/telegram/webhook: отозванный админ не дотягивается до Telegram API', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token-for-test-123456';
    const fetchMock = vi.fn(async (url: string) => {
      const method = String(url).split('/').pop();
      const result = method === 'getMe'
        ? { username: 'test_bot', first_name: 'Тест' }
        : { url: 'https://vedarai.ru/api/telegram/kuzmich' };
      return new Response(JSON.stringify({ ok: true, result }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      cookieToken = await createToken(ADMIN);
      sessionRow = 'revoked';
      await expect(TelegramWebhookPage()).rejects.toBeInstanceOf(RedirectSignal);
      expect(fetchMock).not.toHaveBeenCalled();

      sessionRow = 'db-down';
      await expect(TelegramWebhookPage()).rejects.toBeInstanceOf(RedirectSignal);
      expect(fetchMock).not.toHaveBeenCalled();

      // Контроль: живой админ до Telegram доходит — заглушка fetch рабочая.
      sessionRow = 'live';
      await TelegramWebhookPage();
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });
});

describe('запрет: голый verifyToken вне lib/auth', () => {
  const ROOT = process.cwd();
  const DIRS = ['app', 'components', 'lib', 'hooks', 'contexts'];
  // Кому можно и почему. Запись самоустаревает: перестал звать — убрать.
  const ALLOWED: Record<string, string> = {
    'lib/auth/jwt.ts': 'объявление и verifySessionToken/getUserFromRequest — подпись плюс строка сессии',
    'lib/auth.ts': 'verifyAuth — сразу за подписью сверяет isSessionActive',
  };

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

  // Вызов функции verifyToken(...) или jwt.verifyToken(...), либо её импорт.
  // Переменная с тем же именем (META_VERIFY_TOKEN в вебхуках) — не вызов.
  const CALL = /\bverifyToken\s*\(/;
  const IMPORT = /import\s*(?:type\s*)?\{[^}]*\bverifyToken\b[^}]*\}\s*from\s*['"][^'"]*auth\/jwt['"]/;

  const users = DIRS.flatMap((d) => walk(join(ROOT, d)))
    .map((f) => ({ file: relative(ROOT, f), src: stripComments(readFileSync(f, 'utf-8')) }))
    .filter(({ src }) => CALL.test(src) || IMPORT.test(src))
    .map(({ file }) => file);

  it('вне lib/auth токен сверяют с сессией (verifySessionToken / getUserFromRequest / verifyAuth)', () => {
    expect(users.filter((f) => !(f in ALLOWED))).toEqual([]);
  });

  it('список разрешённых не стоит на месте ушедшего вызова', () => {
    expect(Object.keys(ALLOWED).filter((f) => !users.includes(f))).toEqual([]);
  });
});
