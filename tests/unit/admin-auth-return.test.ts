// @vitest-environment node
/**
 * Админские роуты отвечают администратору, а не падают на собственной
 * проверке входа (#3816, разбор очереди issues 26.11).
 *
 * requireAdmin / requireAuth / requireRole при успехе возвращают данные
 * пользователя (JWTPayload), а при отказе — готовый ответ 401/403. Пять
 * обработчиков писали `if (authError) return authError;`: данные пользователя —
 * не пустое значение, и администратор получал не подборки, а 500 «No response
 * is returned from route handler» — ровно то, что журнал прода записал на
 * GET /api/admin/collections. Сторож прошлого года этого не видел: моки
 * отдавали из requireAdmin `null`, то есть не тот договор, что у настоящей
 * функции.
 *
 * Здесь — настоящий requireAdmin с подписанным токеном и подменённой базой:
 * администратор получает ответ роута, гость — 401. И запрет оборота во всех
 * роутах: вернуть итог проверки входа можно только как NextResponse.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest } from 'next/server';

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => dbQuery(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));

import { createToken } from '@/lib/auth/jwt';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-at-least-32-bytes-long-000';
});

dbQuery.mockImplementation(async (sql: string) => {
  // Строка сессии жива — токен действителен.
  if (/FROM user_sessions/.test(sql)) return { rows: [{ id: 's1' }], rowCount: 1 };
  if (/FROM collections/.test(sql)) return { rows: [{ id: 'c1', slug: 'vulkany', title: 'Вулканы' }], rowCount: 1 };
  if (/UPDATE collections/.test(sql)) return { rows: [], rowCount: 1 };
  if (/DELETE FROM collections/.test(sql)) return { rows: [], rowCount: 1 };
  if (/INSERT INTO collections/.test(sql)) return { rows: [{ id: 'c2', slug: 'new' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});

async function adminRequest(url: string, method = 'GET', body?: unknown) {
  const token = await createToken({ userId: 'u-admin', email: 'admin@example.test', role: 'admin' });
  return new NextRequest(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ID = '11111111-2222-4333-8444-555555555555';

describe('администратор получает ответ роута, а не 500 от своей же проверки входа', () => {
  it('GET /api/admin/collections — подборки', async () => {
    const { GET } = await import('@/app/api/admin/collections/route');
    const res = await GET(await adminRequest('https://vedarai.ru/api/admin/collections'));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collections: [{ id: 'c1', slug: 'vulkany', title: 'Вулканы' }] });
  });

  it('POST /api/admin/collections — создана', async () => {
    const { POST } = await import('@/app/api/admin/collections/route');
    const res = await POST(await adminRequest('https://vedarai.ru/api/admin/collections', 'POST', { slug: 'new', title: 'Новая' }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(201);
  });

  it('PATCH и DELETE /api/admin/collections/[id] — исполнены', async () => {
    const { PATCH, DELETE } = await import('@/app/api/admin/collections/[id]/route');
    const params = { params: Promise.resolve({ id: ID }) };
    const patched = await PATCH(await adminRequest(`https://vedarai.ru/api/admin/collections/${ID}`, 'PATCH', { title: 'Иначе' }), params);
    expect(patched).toBeInstanceOf(Response);
    expect(patched.status).toBe(200);
    const deleted = await DELETE(await adminRequest(`https://vedarai.ru/api/admin/collections/${ID}`, 'DELETE'), params);
    expect(deleted).toBeInstanceOf(Response);
    expect(deleted.status).toBe(200);
  });

  it('POST /api/admin/enrich-places — доходит до своего ответа (пауза 22.10), а не 500', async () => {
    const { POST } = await import('@/app/api/admin/enrich-places/route');
    const res = await POST(await adminRequest('https://vedarai.ru/api/admin/enrich-places', 'POST', {}));
    expect(res).toBeInstanceOf(Response);
    // Модель тексты мест не пишет (lib/places/model-place-text.ts): честный 409.
    expect(res.status).toBe(409);
  });

  it('гость — 401 на каждом, база роута не тронута', async () => {
    const { GET } = await import('@/app/api/admin/collections/route');
    dbQuery.mockClear();
    const res = await GET(new NextRequest('https://vedarai.ru/api/admin/collections'));
    expect(res.status).toBe(401);
    expect(dbQuery.mock.calls.some(([sql]) => /FROM collections/.test(String(sql)))).toBe(false);
  });
});

/**
 * Запрет оборота (сторож судит текст только для запретов, CLAUDE.md §4):
 * `const x = await requireX(...)` и следом `if (x) return x;` — итог проверки
 * входа возвращается без проверки, что это ответ.
 */
describe('итог проверки входа возвращается только как NextResponse', () => {
  const ROOT = process.cwd();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk(join(ROOT, 'app'));

  it('обход прочитал роуты', () => {
    expect(files.filter((f) => f.endsWith('route.ts')).length).toBeGreaterThan(300);
  });

  it('нигде нет `if (x) return x;` после `const x = await requireX(...)`', () => {
    const found: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /const (\w+) = await require(?:Admin|Auth|Role|Operator|Agent|Guide|Partner)\w*\(/.exec(line);
        if (!m) return;
        const next = (lines[i + 1] ?? '').trim();
        if (next === `if (${m[1]}) return ${m[1]};`) found.push(`${relative(ROOT, f)}:${i + 2}`);
      });
    }
    expect(found, 'requireX при успехе возвращает данные пользователя: проверяйте instanceof NextResponse').toEqual([]);
  });
});
