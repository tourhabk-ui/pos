/**
 * Миграции применяет только деплой — через HTTP ни одна не катится.
 *
 * Аудит 15.10, находка P4-04. CLAUDE.md: «НИКОГДА не применять миграции через
 * HTTP endpoint». При этом в админке жили два накатчика:
 * `/api/admin/migrations/run-pending` (кнопка «Применить миграции») и
 * `/api/admin/migrations/apply`. Оба не писали `_migrations`, значит следующий
 * деплой накатывал те же файлы второй раз; первый вдобавок сортировал имена
 * посимвольно (`1000_` раньше `999_`) и записывал конфликт на UPDATE как
 * «Already exists». Правило было, механизм ему противоречил, сторожа не было.
 *
 * Судится вызовом (CLAUDE.md, 13.10), не текстом:
 *   • каждый пишущий метод под `app/api/admin/migrations/` вызывается и обязан
 *     ответить 410, не тронув базу ни одним запросом. Список роутов берётся с
 *     диска: новый накатчик рядом попадает под правило сам;
 *   • каждый GET там же вызывается и обязан звать только SELECT;
 *   • состояние для экрана — на граничных данных: порядок 999/1000, причина
 *     рядом с именем, «не смог прочитать» отдельно от «всё применено».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const { queryMock, connectMock, requireAdminMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  requireAdminMock: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: { query: queryMock, connect: connectMock },
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: requireAdminMock,
}));

import { buildMigrationStatus, findUnappliedMigrations } from '@/lib/agents/migration-status';
import { migrationNumber, sortMigrations } from '@/lib/database/migration-order';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'app/api/admin/migrations');

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (e === 'route.ts') out.push(p);
  }
  return out;
}

const ROUTES = routeFiles(API_DIR).map((abs) => relative(ROOT, abs)).sort();
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

type Handler = (req: NextRequest) => Promise<Response>;

async function loadRoute(rel: string): Promise<Record<string, unknown>> {
  return await import(join(ROOT, rel)) as Record<string, unknown>;
}

function request(rel: string, method: string, body?: unknown): NextRequest {
  const url = 'http://localhost/' + rel.replace(/^app\//, '').replace(/\/route\.ts$/, '');
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const CATALOG = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'));

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockReset();
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('перепись дверей под /api/admin/migrations', () => {
  it('перепись не пуста и видит обе снятые двери', () => {
    // Ноль найденных роутов — отказ переписи, а не «нарушений нет» (§4.0).
    expect(ROUTES).toContain('app/api/admin/migrations/apply/route.ts');
    expect(ROUTES).toContain('app/api/admin/migrations/run-pending/route.ts');
  });

  it('ни один пишущий метод не трогает базу и отвечает 410 с объяснением', async () => {
    let writeHandlers = 0;
    for (const rel of ROUTES) {
      const mod = await loadRoute(rel);
      for (const method of WRITE_METHODS) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        writeHandlers += 1;
        queryMock.mockClear();
        connectMock.mockClear();

        // Тело — то, что слала прежняя кнопка и прежний ручной накат.
        const res = await (handler as Handler)(
          request(rel, method, { dry_run: false, migrations: ['1264'] }),
        );

        expect(res.status, `${method} ${rel}`).toBe(410);
        const json = await res.json() as { success: boolean; error: string };
        expect(json.success).toBe(false);
        expect(json.error).toMatch(/деплой/);
        expect(json.error).toMatch(/migrate-standalone\.js/);
        expect(queryMock, `${method} ${rel} обратился к базе`).not.toHaveBeenCalled();
        expect(connectMock, `${method} ${rel} взял соединение`).not.toHaveBeenCalled();
      }
    }
    // apply и run-pending — минимум два пишущих метода; меньше — перепись ослепла.
    expect(writeHandlers).toBeGreaterThanOrEqual(2);
  });

  it('снятая дверь не анонимна: без прав админа — отказ от requireAdmin, не 410', async () => {
    // Заглушка базы не трогает, но объяснение «как устроен накат» — для админа,
    // а Edge пускает на /api/admin/* ещё и по CRON_SECRET. Проверка прав стоит
    // в хендлере, как у живых роутов (сторож периметра api-guard-before-action).
    let checked = 0;
    for (const rel of ROUTES) {
      const mod = await loadRoute(rel);
      for (const method of WRITE_METHODS) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        checked += 1;
        requireAdminMock.mockReset();
        requireAdminMock.mockResolvedValue(
          NextResponse.json({ error: 'Требуется роль администратора' }, { status: 403 }),
        );
        const res = await (handler as Handler)(request(rel, method, { dry_run: false }));
        expect(requireAdminMock, `${method} ${rel} не спросил права`).toHaveBeenCalledTimes(1);
        expect(res.status, `${method} ${rel} ответил анониму`).toBe(403);
        expect(queryMock).not.toHaveBeenCalled();
        expect(connectMock).not.toHaveBeenCalled();
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('каждый GET там же только читает', async () => {
    let readers = 0;
    for (const rel of ROUTES) {
      const mod = await loadRoute(rel);
      const handler = mod.GET;
      if (typeof handler !== 'function') continue;
      readers += 1;
      queryMock.mockReset();
      queryMock.mockResolvedValue({ rows: [] });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await (handler as Handler)(request(rel, 'GET'));
      expect(queryMock.mock.calls.length, `${rel}: GET не спросил базу`).toBeGreaterThan(0);
      for (const [sql] of queryMock.mock.calls) {
        expect(String(sql), `${rel}: GET пишет`).toMatch(/^\s*SELECT\b/i);
      }
      expect(connectMock).not.toHaveBeenCalled();
    }
    expect(readers).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/admin/migrations/status', () => {
  // Две настоящие неприменённые по обе стороны тысячи: при посимвольном
  // порядке `1264_` встал бы раньше `999_`.
  const sorted = sortMigrations(CATALOG);
  const threeDigit = [...sorted].reverse().find((f) => (migrationNumber(f) ?? 0) < 1000)!;
  const lastFile = sorted[sorted.length - 1]!;
  const otherApplied = sorted[0]!;

  async function callStatus() {
    const { GET } = await import('@/app/api/admin/migrations/status/route');
    return GET(new NextRequest('http://localhost/api/admin/migrations/status'));
  }

  it('называет неприменённые в порядке деплоя и кладёт причину рядом с именем', async () => {
    expect(migrationNumber(lastFile)).toBeGreaterThanOrEqual(1000);
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM _migrations\b/.test(sql)) {
        return { rows: CATALOG.filter((f) => f !== threeDigit && f !== lastFile).map((name) => ({ name })) };
      }
      if (/FROM _migration_failures/.test(sql)) {
        return {
          rows: [
            { name: threeDigit, error: 'column "x" does not exist', attempts: 3, last_failed_at: new Date('2026-10-14T20:00:00Z') },
            { name: otherApplied, error: 'старая запись', attempts: 1, last_failed_at: null },
          ],
        };
      }
      throw new Error(`неожиданный запрос: ${sql}`);
    });

    const res = await callStatus();
    expect(res.status).toBe(200);
    const json = await res.json() as {
      success: boolean; files_total: number; applied_total: number; reasons_known: boolean;
      unapplied: Array<{ name: string; error: string | null; attempts: number | null; last_failed_at: string | null }>;
      other_failures: Array<{ name: string }>;
    };
    expect(json.success).toBe(true);
    expect(json.files_total).toBe(CATALOG.length);
    expect(json.applied_total).toBe(CATALOG.length - 2);
    expect(json.unapplied.map((u) => u.name)).toEqual([threeDigit, lastFile]);
    expect(json.unapplied[0]).toEqual({
      name: threeDigit,
      error: 'column "x" does not exist',
      attempts: 3,
      last_failed_at: '2026-10-14T20:00:00.000Z',
    });
    // У второй записи нет — это незнание, а не «упала без причины».
    expect(json.unapplied[1]).toEqual({ name: lastFile, error: null, attempts: null, last_failed_at: null });
    expect(json.reasons_known).toBe(true);
    // Запись о падении у применённого файла не теряется: по ней будит сторож.
    expect(json.other_failures.map((f) => f.name)).toEqual([otherApplied]);
  });

  it('не прочитался журнал — 500 «не смог», а не «всё применено»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValue(Object.assign(new Error('relation "_migrations" does not exist'), { code: '42P01' }));

    const res = await callStatus();
    expect(res.status).toBe(500);
    const json = await res.json() as { success: boolean; error: string; unapplied?: unknown };
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/_migrations/);
    expect(json.error).toMatch(/42P01/);
    expect(json.unapplied).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it('не прочиталась таблица причин — состояние есть, причины помечены неизвестными', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM _migrations\b/.test(sql)) {
        return { rows: CATALOG.filter((f) => f !== lastFile).map((name) => ({ name })) };
      }
      throw Object.assign(new Error('permission denied'), { code: '42501' });
    });

    const res = await callStatus();
    expect(res.status).toBe(200);
    const json = await res.json() as {
      reasons_known: boolean; failures_error: string | null;
      unapplied: Array<{ name: string; error: string | null }>;
    };
    expect(json.reasons_known).toBe(false);
    expect(json.failures_error).toMatch(/42501/);
    expect(json.unapplied).toEqual([{ name: lastFile, error: null, attempts: null, last_failed_at: null }]);
    // Отказ не глушится: имя проверки и SQLSTATE — в лог.
    expect(err.mock.calls.flat().join(' ')).toMatch(/_migration_failures.*42501/);
  });

  it('без прав админа отвечает отказом и в базу не ходит', async () => {
    requireAdminMock.mockResolvedValue(NextResponse.json({ error: 'Требуется роль администратора' }, { status: 403 }));
    const res = await callStatus();
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('сводка для экрана — на граничных данных', () => {
  it('неприменённые идут числовым порядком, не посимвольным', () => {
    const files = ['1000_a.sql', '999_b.sql', '100_c.sql', '144b_d.sql', '144a_e.sql'];
    expect(findUnappliedMigrations(files, [])).toEqual(
      ['100_c.sql', '144a_e.sql', '144b_d.sql', '999_b.sql', '1000_a.sql'],
    );
  });

  it('таблица причин не прочитана — у всех error: null и reasons_known: false', () => {
    const r = buildMigrationStatus(['001_a.sql', '002_b.sql'], ['001_a.sql'], null);
    expect(r.reasons_known).toBe(false);
    expect(r.unapplied).toEqual([{ name: '002_b.sql', error: null, attempts: null, last_failed_at: null }]);
    expect(r.other_failures).toEqual([]);
  });

  it('не-SQL файлы каталога не считаются ни в итоге, ни в неприменённых', () => {
    const r = buildMigrationStatus(['001_a.sql', 'MIGRATION_ORDER.md'], ['001_a.sql'], []);
    expect(r.files_total).toBe(1);
    expect(r.applied_total).toBe(1);
    expect(r.unapplied).toEqual([]);
  });
});
