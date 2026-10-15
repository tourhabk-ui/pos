/**
 * Серверные страницы хаба сверяют роль ДО чтения данных (аудит 15.10, P3-22).
 *
 * ── Повод ────────────────────────────────────────────────────────────────
 *
 * Edge (`middleware.ts`, §7 — не трогаем) на `/hub/*` проверяет только подпись
 * JWT; роль он сверяет лишь для `/api/*`. Роль страницы хаба держал
 * клиентский `HubLayout` — уже после того, как сервер выполнил запрос
 * страницы. `/hub/admin/channels` читал `channel_orders` и `operator_tours`
 * прямо в серверном компоненте, и любой вошедший турист получал агрегаты
 * в RSC-пейлоаде до клиентского перенаправления. Соседние `safety` и
 * `telegram/webhook` делали проверку руками — правило было известно, но
 * ничем не держалось.
 *
 * ── Что держит сторож ────────────────────────────────────────────────────
 *
 * Отбор — перепись диска: серверная `page.tsx` под `app/hub`, которая
 * импортирует серверный код проекта (не клиентский модуль) или пакет кроме
 * react/next/lucide-react. Только у таких страниц тело может читать данные.
 *
 * Приговор — вызов самой страницы (async-компонента) с поддельной кукой:
 *  - без входа и в чужой роли — redirect или notFound, и НИ ОДИН источник
 *    данных не тронут (пул, `lib/database` кроме проверки сессии,
 *    `platform-settings`, сеть);
 *  - в своей роли — страница рендерится, без перенаправления.
 * Источники замоканы на уровне пула и `lib/database`, поэтому сервис,
 * читающий базу через них, тоже попадает под проверку.
 *
 * Публичная страница с данными (в разделе из `PUBLIC_HUB_PATHS`) вносится в
 * `PUBLIC_DATA_PAGES` с причиной. Запись самоустаревает: страница перестала
 * читать данные или раздел перестал быть публичным — тест требует её убрать.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createToken } from '@/lib/auth/jwt';
import { ROLE_HUB } from '@/lib/auth/role-routes';

const h = vi.hoisted(() => ({
  token: undefined as string | undefined,
  sessionAlive: true,
  touched: [] as string[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'auth_token' && h.token ? { name, value: h.token } : undefined),
  }),
  headers: async () => new Headers(),
}));

/** Проверка сессии (`user_sessions`) — часть гейта, а не чтение данных страницы. */
vi.mock('@/lib/database', () => ({
  query: vi.fn(async (sql: string) => {
    if (/FROM\s+user_sessions/i.test(sql)) return { rows: h.sessionAlive ? [{ id: 'sess-1' }] : [] };
    h.touched.push(`database.query: ${sql.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
    return { rows: [] };
  }),
  transaction: vi.fn(async () => {
    h.touched.push('database.transaction');
    return undefined;
  }),
}));

const ORDERS = [{ channel: 'avito', count: '3', last_at: '2026-10-14 10:00:00+00' }];
const TOURS = { total: '8', with_tripster: '0', with_avito: '8', with_sputnik8: '0' };

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      h.touched.push(`pool.query: ${sql.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
      if (/FROM\s+channel_orders/i.test(sql)) return { rows: ORDERS };
      if (/FROM\s+operator_tours/i.test(sql)) return { rows: [TOURS] };
      return { rows: [] };
    }),
    connect: vi.fn(async () => {
      h.touched.push('pool.connect');
      throw new Error('в тесте базы нет');
    }),
  },
}));

vi.mock('@/lib/platform-settings', () => ({
  getSetting: vi.fn(async (key: string) => {
    h.touched.push(`getSetting: ${key}`);
    return null;
  }),
}));

const root = process.cwd();

// ── Перепись ────────────────────────────────────────────────────────────

const CLIENT_RE = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/;
const isClientModule = (src: string) => CLIENT_RE.test(src);

/** Пакеты, которые сами данных страницы не читают. */
const INERT_PACKAGES = /^(?:react|react-dom|next|next\/.+|lucide-react)$/;

function walkPages(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkPages(p, out);
    else if (e === 'page.tsx' || e === 'page.ts') out.push(p);
  }
  return out;
}

function resolveProjectModule(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? join(root, spec.slice(2)) : resolve(dirname(from), spec);
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** Что из импортов страницы может исполнить серверный код (пусто — тело данных не читает). */
function serverImports(file: string): string[] {
  const src = readFileSync(file, 'utf-8');
  const specs = [...src.matchAll(/^import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gms)].map(m => m[1]);
  return specs.filter(spec => {
    if (spec.startsWith('@/') || spec.startsWith('.')) {
      const p = resolveProjectModule(spec, file);
      // Не нашли файл — не можем сказать, клиентский ли он: считаем серверным (§4.0).
      return p === null || !isClientModule(readFileSync(p, 'utf-8'));
    }
    return !INERT_PACKAGES.test(spec);
  });
}

const SERVER_DATA_PAGES = walkPages(join(root, 'app/hub'))
  .filter(f => !isClientModule(readFileSync(f, 'utf-8')))
  .filter(f => serverImports(f).length > 0)
  .map(f => relative(root, f).split('\\').join('/'))
  .sort();

/** Публичные разделы хаба — из кода Edge (комментарии вырезаны). */
function publicHubPaths(): string[] {
  const code = readFileSync(join(root, 'middleware.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const m = code.match(/const PUBLIC_HUB_PATHS[^=]*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('в middleware.ts не найден PUBLIC_HUB_PATHS');
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

/** Публичные страницы хаба, читающие данные, — каждая с причиной. */
const PUBLIC_DATA_PAGES: Record<string, string> = {
  'app/hub/fishing/page.tsx':
    'посадочная «Рыбалка» из шапки сайта: раздел в PUBLIC_HUB_PATHS, читает только опубликованные туры для витрины',
};

const urlOf = (file: string) => '/' + file.replace(/^app\//, '').replace(/\/page\.tsx?$/, '');
const sectionOf = (file: string) => '/hub/' + file.split('/')[2];
const isPublic = (file: string) => publicHubPaths().some(p => urlOf(file) === p || urlOf(file).startsWith(p + '/'));

/** Роли, чей кабинет — раздел страницы. */
function rolesFor(file: string): string[] {
  const section = sectionOf(file);
  return Object.entries(ROLE_HUB).filter(([, hub]) => hub === section).map(([role]) => role);
}

const GATED_PAGES = SERVER_DATA_PAGES.filter(f => !isPublic(f));

// ── Вызов страницы ──────────────────────────────────────────────────────

type Outcome =
  | { kind: 'redirect'; url: string }
  | { kind: 'notFound' }
  | { kind: 'rendered'; value: unknown }
  | { kind: 'error'; error: unknown };

async function callPage(file: string): Promise<Outcome> {
  const mod = (await import(/* @vite-ignore */ join(root, file))) as {
    default: (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => unknown;
  };
  try {
    const value = await mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve({}) });
    return { kind: 'rendered', value };
  } catch (error) {
    const digest = (error as { digest?: unknown } | null)?.digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;')) {
      return { kind: 'redirect', url: digest.split(';')[2] ?? '' };
    }
    if (typeof digest === 'string' && digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')) return { kind: 'notFound' };
    return { kind: 'error', error };
  }
}

async function tokenFor(role: string): Promise<string> {
  return createToken({ userId: `u-${role}`, email: `${role}@example.test`, role });
}

const prevSecret = process.env.JWT_SECRET;
const prevTgToken = process.env.TELEGRAM_BOT_TOKEN;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-hub-server-pages-role-gate-0123456789';
  delete process.env.TELEGRAM_BOT_TOKEN;
  h.token = undefined;
  h.sessionAlive = true;
  h.touched = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    h.touched.push(`fetch: ${String(url)}`);
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevSecret;
  if (prevTgToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevTgToken;
});

// ── Перепись держит саму себя ───────────────────────────────────────────

describe('перепись серверных страниц хаба', () => {
  it('находит страницу, с которой начался разбор, — отбор не пуст', () => {
    expect(SERVER_DATA_PAGES).toContain('app/hub/admin/channels/page.tsx');
  });

  it('публичная страница с данными записана с причиной, закрытой — нет в списке публичных', () => {
    const unlisted = SERVER_DATA_PAGES.filter(f => isPublic(f) && !PUBLIC_DATA_PAGES[f]);
    expect(unlisted, `публичная страница читает данные без записи с причиной: ${unlisted.join(', ')}`).toEqual([]);
  });

  it('запись PUBLIC_DATA_PAGES самоустаревает: страница читает данные и раздел публичен', () => {
    for (const [file, reason] of Object.entries(PUBLIC_DATA_PAGES)) {
      expect(reason.length, `${file}: причина пуста`).toBeGreaterThan(20);
      expect(SERVER_DATA_PAGES, `${file} больше не читает данные — запись убрать`).toContain(file);
      expect(isPublic(file), `${file} больше не в публичном разделе — запись убрать`).toBe(true);
    }
  });

  it('у каждого закрытого раздела со страницей данных есть роль', () => {
    const orphan = GATED_PAGES.filter(f => rolesFor(f).length === 0);
    expect(orphan, `раздел без роли в ROLE_HUB: ${orphan.join(', ')}`).toEqual([]);
  });
});

// ── Приговор — вызовом ──────────────────────────────────────────────────

describe.each(GATED_PAGES)('%s', file => {
  const allowed = rolesFor(file);
  const stranger = allowed.includes('tourist') ? 'operator' : 'tourist';

  it('без входа — перенаправление, данные не читаются', async () => {
    const out = await callPage(file);
    expect(['redirect', 'notFound'], JSON.stringify(out)).toContain(out.kind);
    expect(h.touched).toEqual([]);
  });

  it(`в чужой роли (${stranger}) — перенаправление, данные не читаются`, async () => {
    h.token = await tokenFor(stranger);
    const out = await callPage(file);
    expect(['redirect', 'notFound'], JSON.stringify(out)).toContain(out.kind);
    expect(h.touched).toEqual([]);
  });

  it(`в своей роли (${allowed[0]}) — страница рендерится`, async () => {
    h.token = await tokenFor(allowed[0]);
    const out = await callPage(file);
    expect(out.kind, JSON.stringify(out)).toBe('rendered');
  });
});

// ── Страница находки — подробно ─────────────────────────────────────────

describe('/hub/admin/channels', () => {
  const FILE = 'app/hub/admin/channels/page.tsx';

  it('админ: оба запроса выполнены, агрегаты дошли до клиента', async () => {
    h.token = await tokenFor('admin');
    const out = await callPage(FILE);
    expect(out.kind).toBe('rendered');
    const props = (out as { value: { props: { orders: unknown; tours: unknown } } }).value.props;
    expect(props.orders).toEqual(ORDERS);
    expect(props.tours).toEqual(TOURS);
    expect(h.touched.filter(t => t.startsWith('pool.query'))).toHaveLength(2);
  });

  it('турист: в свой кабинет, ни одного запроса', async () => {
    h.token = await tokenFor('tourist');
    const out = await callPage(FILE);
    expect(out).toEqual({ kind: 'redirect', url: '/hub/tourist' });
    expect(h.touched).toEqual([]);
  });

  it('без входа: на вход с возвратом на страницу', async () => {
    const out = await callPage(FILE);
    expect(out).toEqual({ kind: 'redirect', url: '/auth/login?from=%2Fhub%2Fadmin%2Fchannels' });
    expect(h.touched).toEqual([]);
  });

  it('админ с отозванной сессией (после выхода): на вход, ни одного запроса', async () => {
    h.token = await tokenFor('admin');
    h.sessionAlive = false;
    const out = await callPage(FILE);
    expect(out).toEqual({ kind: 'redirect', url: '/auth/login?from=%2Fhub%2Fadmin%2Fchannels' });
    expect(h.touched).toEqual([]);
  });

  it('поддельная подпись: на вход, ни одного запроса', async () => {
    h.token = await tokenFor('admin');
    process.env.JWT_SECRET = 'другой-секрет-подпись-не-сходится-0123456789';
    const out = await callPage(FILE);
    expect(out.kind).toBe('redirect');
    expect(h.touched).toEqual([]);
  });
});
