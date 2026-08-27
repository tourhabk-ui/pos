/**
 * execute-all — батч-исполнитель одобренных инициатив — заперт на владельца.
 *
 * Находка 27.08 (сверка внешнего аудита с кодом): ручка принимала
 * CRON_SECRET — секрет ДЛЯ КРОНОВ, расшаренный в GitHub Secrets и настройках
 * внешних расписаний, — и имела режим ?force=1, одобрявший ВСЕ pending-заявки
 * одним запросом с немедленным исполнением. А initiative-executor умеет
 * настоящие мутации: блокировку пользователей и IP, архив SOS-событий,
 * приостановку туров, смену комиссий операторов. Ни один workflow/скрипт
 * ручку не звал — то же «заряженное, но не нажимаемое ружьё», что
 * ACTION_CATEGORIES до PR #1399, и снято оно тем же способом: сузить до
 * реально нужного, а не ждать, когда кто-нибудь нажмёт.
 *
 * Сторож держит три края: admin-JWT вместо кронового секрета, отсутствие
 * force-режима, и незыблемость выборки — исполняется только то, что человек
 * уже одобрил (status = 'approved').
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const SRC = readFileSync(join(process.cwd(), 'app/api/admin/execute-all/route.ts'), 'utf-8');

describe('execute-all: статика исходника', () => {
  it('авторизация — requireAdmin, кроновый секрет не принимается', () => {
    expect(SRC).toMatch(/requireAdmin\(req\)/);
    expect(SRC).not.toMatch(/verifyCronSecret|getCronSecret/);
  });

  it('force-режима нет: массовое одобрение pending невозможно', () => {
    // Ловим и параметр, и сам массовый UPDATE pending→approved.
    expect(SRC).not.toMatch(/searchParams\.get\('force'\)/);
    expect(SRC).not.toMatch(/SET status = 'approved'[\s\S]{0,200}WHERE status = 'pending'/);
  });

  it('исполняется только одобренное человеком', () => {
    expect(SRC).toMatch(/WHERE status = 'approved'/);
  });
});

// ── Поведение: без admin-JWT — отказ до единого запроса к БД ────────────────

const { requireAdminMock, poolQueryMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...a: unknown[]) => requireAdminMock(...a),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));
vi.mock('@/lib/agents/execution/initiative-executor', () => ({
  executeInitiative: vi.fn(),
}));

function req(url: string): NextRequest {
  return new NextRequest(url);
}

describe('execute-all: поведение авторизации', () => {
  beforeEach(() => {
    requireAdminMock.mockReset();
    poolQueryMock.mockReset();
  });

  it('не-админ получает отказ, БД не трогается', async () => {
    requireAdminMock.mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const { GET } = await import('@/app/api/admin/execute-all/route');

    const res = await GET(req('http://l/api/admin/execute-all?hours=12'));

    expect(res.status).toBe(401);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('админ проходит: stats-режим отвечает без исполнения', async () => {
    requireAdminMock.mockResolvedValueOnce({ userId: 1, role: 'admin' });
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ completed: '0', running: '0', total: '0', first_at: null, last_at: null }] })
      .mockResolvedValueOnce({ rows: [] });
    const { GET } = await import('@/app/api/admin/execute-all/route');

    const res = await GET(req('http://l/api/admin/execute-all?stats=1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('approvals');
  });
});
