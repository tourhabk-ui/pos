/**
 * Узкий кабинет и тестовый профиль (24.10).
 * Меню «Войти как» остаётся в окне 390px, админская конверсия пишется
 * «0,0 %», плавающая кнопка чата в кабинете оператора не рисуется,
 * тестовый партнёр не входит в витрины.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { roleMenuBox } from '@/components/layout/RoleSwitcher';
import { formatRuPercent } from '@/lib/format/ru-percent';
import { notTestPartnerSql, excludeTestPartnerTourSql } from '@/lib/partners/test-profile';
import { publicTourSql } from '@/lib/tours/public-visibility';

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('меню «Войти как» не выходит за край окна', () => {
  it('у левой кнопки на 390px меню начинается внутри экрана', () => {
    const box = roleMenuBox(40, 390);
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.left + box.width).toBeLessThanOrEqual(390 - 8);
  });

  it('у правой кнопки меню прижато к ней и тоже внутри', () => {
    const box = roleMenuBox(380, 390);
    expect(box.left).toBe(380 - 192);
    expect(box.left + box.width).toBeLessThanOrEqual(382);
  });

  it('широкий экран держит меню у кнопки', () => {
    expect(roleMenuBox(1100, 1280).left).toBe(1100 - 192);
  });

  it('чужой псевдоним в SQL отметки не подставляется', () => {
    expect(() => notTestPartnerSql('p;drop')).toThrow();
    expect(() => excludeTestPartnerTourSql('ot;drop')).toThrow();
  });
});

describe('конверсия админки — запятая и пробел', () => {
  it('ноль пишется «0,0 %»', () => {
    expect(formatRuPercent(0)).toBe('0,0 %');
    expect(formatRuPercent(12.5)).toBe('12,5 %');
  });
});

describe('шлюз витрины не пускает тестового партнёра', () => {
  it('каталог, поиск и MCP зовут шлюз, а шлюз отсекает тест', () => {
    const sql = publicTourSql('ot');
    expect(sql).toContain('ot.is_published = true');
    expect(sql).toContain(excludeTestPartnerTourSql('ot'));
    expect(sql).toContain('partners_test_gate.is_test IS TRUE');
  });

  it('список операторов, страница, sitemap, планер и Telegram зовут notTestPartnerSql', () => {
    const files = [
      'lib/operators/list-query.ts',
      'app/operators/[slug]/page.tsx',
      'app/api/operators/[slug]/route.ts',
      'lib/seo/sitemap-entries.ts',
      'app/api/planner/partners/route.ts',
      'app/api/telegram/webhook/route.ts',
    ];
    for (const f of files) {
      expect(src(f), f).toContain('notTestPartnerSql(');
    }
  });

  it('в кабинете оператора нет плавающей кнопки чата', () => {
    const layout = src('app/hub/operator/layout.tsx');
    expect(layout).not.toMatch(/<ChatWidget/);
    expect(layout).not.toContain("from '@/components/chat/ChatWidget'");
  });

  it('миграция ставит отметку оператору FLO и никому больше по умолчанию', () => {
    const sql = src('migrations/1331_partner_test_profile.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE');
    expect(sql).toContain("lower(u.email) = 'flo@vedarai.ru'");
    expect(sql).toContain("p.category = 'operator'");
  });
});

describe('меню на 390px рисуется внутри окна', () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    rect.mockReturnValue({
      right: 40, bottom: 48, left: 0, top: 12, width: 40, height: 36, x: 0, y: 12, toJSON() { return {}; },
    });
  });
  afterEach(() => {
    rect.mockRestore();
    cleanup();
  });

  it('открытое меню не уходит влево за 8px', async () => {
    vi.resetModules();
    vi.doMock('@/contexts/AuthContext', () => ({
      useAuth: () => ({
        user: {
          id: 'u', email: 'a@vedarai.ru', name: 'Админ', role: 'admin',
          roles: ['admin'], preferences: {}, createdAt: new Date(), updatedAt: new Date(),
        },
        switchRole: vi.fn(),
      }),
    }));
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
    const { RoleSwitcher } = await import('@/components/layout/RoleSwitcher');
    render(<RoleSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Переключить роль' }));
    const menu = await screen.findByRole('menu');
    const left = Number.parseFloat(menu.style.left);
    const width = Number.parseFloat(menu.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(382);
    expect(screen.getByText('Войти как')).toBeTruthy();
  });
});

const requireAdmin = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...a) }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));

describe('отметка тестового профиля — только администратор', () => {
  beforeEach(() => {
    requireAdmin.mockReset();
    query.mockReset();
  });

  it('без прав администратора база не трогается', async () => {
    requireAdmin.mockResolvedValue(NextResponse.json({ error: 'Нет доступа' }, { status: 403 }));
    const { PATCH } = await import('@/app/api/admin/operators/[id]/test-profile/route');
    const res = await PATCH(
      new Request('http://localhost/api/admin/operators/x/test-profile', {
        method: 'PATCH',
        body: JSON.stringify({ is_test: true }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
    );
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('администратор записывает отметку и получает её обратно', async () => {
    requireAdmin.mockResolvedValue({ id: 'admin' });
    query.mockResolvedValue({ rows: [{ id: '11111111-1111-4111-8111-111111111111', is_test: true, name: 'FLO' }] });
    const { PATCH } = await import('@/app/api/admin/operators/[id]/test-profile/route');
    const res = await PATCH(
      new Request('http://localhost/api/admin/operators/x/test-profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_test: true }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { is_test: boolean; name: string } };
    expect(body.data.is_test).toBe(true);
    expect(body.data.name).toBe('FLO');
    expect(String(query.mock.calls[0][0])).toContain('SET is_test = $2');
    expect(query.mock.calls[0][1]).toEqual(['11111111-1111-4111-8111-111111111111', true]);
  });

  it('без поля is_test отметка не пишется', async () => {
    requireAdmin.mockResolvedValue({ id: 'admin' });
    const { PATCH } = await import('@/app/api/admin/operators/[id]/test-profile/route');
    const res = await PATCH(
      new Request('http://localhost/api/admin/operators/x/test-profile', {
        method: 'PATCH',
        body: JSON.stringify({ hidden: true }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
    );
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

const METRIC = { value: 0, change: 0, trend: 'neutral' };

describe('дашборд администратора показывает процент с запятой', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('конверсия 0 рисуется как «0,0 %»', async () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    }));
    vi.doMock('@/app/hub/admin/_DaySummary', () => ({ default: () => null }));
    vi.doMock('@/app/hub/admin/_AdminMessengers', () => ({ default: () => null }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/admin/dashboard')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              metrics: {
                totalRevenue: METRIC,
                totalBookings: METRIC,
                activeUsers: METRIC,
                conversionRate: { value: 0, change: 1.5, trend: 'up' },
                pwaInstalls: METRIC,
              },
              charts: { topTours: [] },
              recentActivities: [],
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const { default: Dashboard } = await import('@/app/hub/admin/page');
    render(<Dashboard />);
    const zeros = await screen.findAllByText('0,0 %');
    expect(zeros.length).toBeGreaterThan(0);
    expect(await screen.findByText('1,5 %')).toBeTruthy();
    expect(screen.queryByText(/0\.0/)).toBeNull();
  });
});
