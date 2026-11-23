// @vitest-environment jsdom
/**
 * Прокат автомобилей — роль `cars` в кабинете перевозчика (план готовности
 * 23.11, этап 3a).
 *
 * Категория карточки `cars` жила в коде давно (страница /car-rental/[slug],
 * чат, список компаний без прокатчиков), а роли пользователя не было:
 * зарегистрироваться прокатчиком было нельзя. Роль заведена без нового хаба —
 * кабинет проката остаётся разделом кабинета перевозчика, где им пользуется
 * «Лагуна Прокат» (она перевозчик и здесь не меняется).
 *
 * Прокатчику открыт только раздел «Прокат»: разделы перевозчика закрыты на
 * сервере отказом 403, а не одной вёрсткой. Судится вызовом двери и рендером.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const { requireRole, ensurePartnerForRole, auth, nav, hubProps } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  ensurePartnerForRole: vi.fn(),
  auth: { role: 'cars' as string | undefined },
  nav: { pathname: '/hub/carrier', replace: vi.fn() },
  hubProps: { last: null as null | { sidebarItems: Array<{ href: string; label: string }>; sidebarTitle: string; requiredRole: string[] } },
}));
vi.mock('@/lib/auth/middleware', () => ({ requireRole }));
vi.mock('@/lib/auth/partner-profile', () => ({ ensurePartnerForRole }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.role ? { id: 'u1', role: auth.role } : null, isLoading: false }) }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ replace: nav.replace, push: vi.fn() }) }));
vi.mock('@/components/hub/PartnerChannelBanner', () => ({ PartnerChannelBanner: () => null }));
vi.mock('@/components/layout/HubLayout', () => ({
  HubLayout: (props: { children: React.ReactNode; sidebarItems: Array<{ href: string; label: string }>; sidebarTitle: string; requiredRole: string[] }) => {
    hubProps.last = props;
    return <div data-testid="hub">{props.children}</div>;
  },
}));

import { requireCarrier, CARRIER_ROLES, RENTAL_ONLY_TEXT } from '@/lib/transfers/carrier-auth';
import CarrierHubLayout from '@/app/hub/carrier/layout';
import { ROLE_HUB, PARTNER_ROLES } from '@/lib/auth/role-routes';
import { ROLE_TO_CATEGORY } from '@/lib/crm/partner-context';
import { PARTNER_CATEGORY_LABELS } from '@/lib/partners/categories';
import { ROLE_LABELS, SWITCHABLE_ROLES } from '@/lib/auth/role-switch';
import { INBOX_BY_CATEGORY, INBOX_NOT_HERE } from '@/lib/crm/inbox-kinds';

const req = () => new NextRequest('http://localhost/api/hub/carrier/rental');
const signedIn = (role: string) => requireRole.mockResolvedValue({ userId: 'u1', role, email: 'x@example.com' });

beforeEach(() => {
  requireRole.mockReset();
  ensurePartnerForRole.mockReset();
  ensurePartnerForRole.mockResolvedValue('p1');
  nav.replace.mockReset();
  hubProps.last = null;
});
afterEach(() => cleanup());

describe('requireCarrier: прокатчику открыт только раздел «Прокат»', () => {
  it('роль cars допущена к кабинету', async () => {
    expect(CARRIER_ROLES).toContain('cars');
    signedIn('cars');
    await requireCarrier(req(), { rental: true });
    expect(requireRole.mock.calls[0][1]).toEqual(expect.arrayContaining(['transfer', 'cars']));
  });

  it('раздел проката: карточка ищется по категории cars, а не transfer', async () => {
    signedIn('cars');
    const r = await requireCarrier(req(), { rental: true });
    expect(r).not.toBeInstanceOf(NextResponse);
    expect(ensurePartnerForRole).toHaveBeenCalledWith('u1', 'cars');
    expect(r).toMatchObject({ partnerId: 'p1', category: 'cars' });
  });

  it('раздел перевозчика: отказ 403 словами, карточка не заводится', async () => {
    signedIn('cars');
    const r = await requireCarrier(req());
    expect(r).toBeInstanceOf(NextResponse);
    const res = r as NextResponse;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: RENTAL_ONLY_TEXT });
    expect(ensurePartnerForRole).not.toHaveBeenCalled();
  });

  it.each([['transfer'], ['transfer_operator']])('перевозчик (%s): как прежде, в обоих разделах — карточка transfer', async (role) => {
    signedIn(role);
    for (const opts of [undefined, { rental: true }]) {
      const r = await requireCarrier(req(), opts);
      expect(r).toMatchObject({ partnerId: 'p1', category: 'transfer' });
    }
    expect(ensurePartnerForRole).toHaveBeenCalledTimes(2);
    for (const call of ensurePartnerForRole.mock.calls) expect(call).toEqual(['u1', 'transfer']);
  });

  it('не вошёл или чужая роль — ответ двери роли, без карточки', async () => {
    const denied = NextResponse.json({ error: 'нет' }, { status: 403 });
    requireRole.mockResolvedValue(denied);
    expect(await requireCarrier(req(), { rental: true })).toBe(denied);
    expect(ensurePartnerForRole).not.toHaveBeenCalled();
  });
});

describe('роуты кабинета: rental: true — только у раздела «Прокат»', () => {
  const ROOT = process.cwd();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry === 'route.ts') files.push(p);
    }
  };
  walk(join(ROOT, 'app/api/hub/carrier'));
  const rel = (f: string) => relative(ROOT, f).split('\\').join('/');

  it('перепись не пуста', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.some((f) => rel(f).startsWith('app/api/hub/carrier/rental/'))).toBe(true);
  });

  it('каждый вызов двери в разделе проката открыт прокатчику, в остальных — нет', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      const calls = src.match(/requireCarrier\([^)]*\)/g) ?? [];
      expect(calls.length, rel(file)).toBeGreaterThan(0);
      const inRental = rel(file).startsWith('app/api/hub/carrier/rental/');
      for (const call of calls) {
        expect(/rental:\s*true/.test(call), `${rel(file)}: ${call}`).toBe(inRental);
      }
    }
  });
});

describe('вёрстка кабинета', () => {
  it('прокатчик: без раздела перевозчика, с главной уводится в «Прокат»', () => {
    auth.role = 'cars';
    nav.pathname = '/hub/carrier';
    const { queryByText } = render(<CarrierHubLayout><p>парк перевозчика</p></CarrierHubLayout>);
    expect(hubProps.last?.sidebarItems.map((i) => i.href)).toEqual([
      '/hub/carrier/rental', '/hub/carrier/inbox', '/hub/carrier/clients', '/hub/carrier/tasks',
    ]);
    expect(hubProps.last?.sidebarTitle).toBe('Прокат автомобилей');
    expect(nav.replace).toHaveBeenCalledWith('/hub/carrier/rental');
    // Экран перевозчика прокатчику не рисуется даже на миг до перехода.
    expect(queryByText('парк перевозчика')).toBeNull();
  });

  it('прокатчик в своём разделе: экран на месте, никуда не уводится', () => {
    auth.role = 'cars';
    nav.pathname = '/hub/carrier/rental';
    const { queryByText } = render(<CarrierHubLayout><p>мои машины</p></CarrierHubLayout>);
    expect(queryByText('мои машины')).not.toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('перевозчик: кабинет как прежде', () => {
    auth.role = 'transfer';
    nav.pathname = '/hub/carrier';
    const { queryByText } = render(<CarrierHubLayout><p>парк перевозчика</p></CarrierHubLayout>);
    expect(hubProps.last?.sidebarItems.map((i) => i.href)).toEqual([
      '/hub/carrier', '/hub/carrier/rental', '/hub/carrier/inbox', '/hub/carrier/clients', '/hub/carrier/tasks',
    ]);
    expect(hubProps.last?.sidebarTitle).toBe('Перевозчик');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(queryByText('парк перевозчика')).not.toBeNull();
  });

  it('гейт кабинета пускает прокатчика', () => {
    auth.role = 'cars';
    nav.pathname = '/hub/carrier/rental';
    render(<CarrierHubLayout><p>x</p></CarrierHubLayout>);
    expect(hubProps.last?.requiredRole).toEqual(['transfer', 'transfer_operator', 'cars', 'admin']);
  });
});

describe('роль cars — одно слово с категорией карточки, во всех справочниках', () => {
  it('роль ↔ категория, кабинет, подписи', () => {
    expect(PARTNER_ROLES).toContain('cars');
    expect(ROLE_TO_CATEGORY.cars).toBe('cars');
    expect(ROLE_HUB.cars).toBe('/hub/carrier/rental');
    expect(PARTNER_CATEGORY_LABELS.cars).toBe('Прокат автомобилей');
    expect(SWITCHABLE_ROLES).toContain('cars');
    // Подпись отличается от проката снаряжения: в переключателе ролей их не спутать.
    expect(ROLE_LABELS.cars).toBe('Прокат авто');
    expect(ROLE_LABELS.cars).not.toBe(ROLE_LABELS.gear);
  });

  it('во «Входящих» своего вида нет, и сказано, где отвечают на заявки', () => {
    expect(INBOX_BY_CATEGORY.cars).toEqual([]);
    expect(INBOX_NOT_HERE.cars.join(' ')).toContain('в разделе «Прокат»');
  });

  it('перевозчик не тронут: его роль и кабинет прежние', () => {
    expect(ROLE_HUB.transfer).toBe('/hub/carrier');
    expect(ROLE_TO_CATEGORY.transfer).toBe('transfer');
  });
});
