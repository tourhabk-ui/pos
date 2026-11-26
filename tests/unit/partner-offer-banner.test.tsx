/**
 * «Примите оферту» при входе в кабинет партнёра.
 *
 * Слово владельца 24.11: «Партнёры, заведённые до оферты, принимают её при
 * следующем входе в кабинет, до сезона». До этого дня принять оферту можно
 * было только необязательным пунктом чек-листа на главной кабинета.
 *
 * Здесь — слова просьбы вызовом, плашка рендером, layout каждого кабинета
 * рендером (плашка стоит во всех пяти) и роут состояния вызовом. Журнал и
 * дверь акцепта на схеме прода судит
 * tests/integration/partner-readiness.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/operator',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/components/layout/HubLayout', () => ({
  HubLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/chat/ChatWidget', () => ({ ChatWidget: () => null }));
vi.mock('@/components/operator/ForcePasswordChangeBanner', () => ({ ForcePasswordChangeBanner: () => null }));
vi.mock('@/components/hub/PartnerChannelBanner', () => ({ PartnerChannelBanner: () => null }));
vi.mock('@/components/operator/MemberChannelBanner', () => ({ MemberChannelBanner: () => null }));
vi.mock('@/components/operator/use-operator-seat', async (orig) => ({
  ...(await orig<typeof import('@/components/operator/use-operator-seat')>()),
  useOperatorSeat: () => ({ state: 'ok', kind: 'owner', perms: { can_edit_prices: true, can_cancel_bookings: true } }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'transfer' }, loading: false }) }));

const door = vi.hoisted(() => ({
  ctx: { partnerId: 'c8000000-0000-4000-8000-000000000001', category: 'operator', userId: 'u1', seat: 'owner' } as Record<string, unknown> | null,
  read: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@/lib/crm/partner-context', async () => {
  const { NextResponse: Res } = await import('next/server');
  return {
    requirePartner: vi.fn(async () => door.ctx ?? Res.json({ success: false, error: 'Требуется вход' }, { status: 401 })),
  };
});
vi.mock('@/lib/legal/offer-acceptance', () => ({
  readOfferAcceptance: door.read,
  recordOfferAcceptanceForPartner: door.record,
}));

import { PartnerOfferBanner } from '@/components/hub/PartnerOfferBanner';
import { OFFER_ASK_TAG, OFFER_EDITION, OFFER_VERSION, offerAskWords } from '@/lib/legal/offer';
import { GET } from '@/app/api/hub/partner/offer/route';
import OperatorHubLayout from '@/app/hub/operator/layout';
import GuideHubLayout from '@/app/hub/guide/layout';
import StayHubLayout from '@/app/hub/stay/layout';
import GearHubLayout from '@/app/hub/gear/layout';
import CarrierHubLayout from '@/app/hub/carrier/layout';

type Call = { url: string; method: string; body: unknown };
/** Подложенный сервер: состояние просьбы и ответ двери акцепта. */
function stubOffer(ask: unknown, accept: { status?: number; body: unknown } = { body: { success: true, data: { version: OFFER_VERSION } } }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url) === '/api/hub/partner/offer' && method === 'POST') {
      return { ok: (accept.status ?? 200) < 400, status: accept.status ?? 200, json: async () => accept.body };
    }
    if (String(url) === '/api/hub/partner/offer') {
      if (ask instanceof Error) throw ask;
      const status = (ask as { status?: number } | null)?.status ?? 200;
      return { ok: status < 400, status, json: async () => ask };
    }
    // Остальное (гейт кабинета оператора и т.п.) — «всё в порядке».
    return { ok: true, status: 200, json: async () => ({ success: true, data: { onboarding_completed: true } }) };
  }));
  return calls;
}
const asked = (state: string, previous = false) => ({ success: true, data: { state, previous, edition: OFFER_EDITION } });
const banner = () => screen.queryByTestId('partner-offer-banner');

beforeEach(() => { window.sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('слова просьбы', () => {
  it('владельцу: принять, редакция названа, срок — словами владельца, без даты; заявки идут как раньше', () => {
    expect(offerAskWords('needed', false)).toBe(
      'Примите оферту для партнёров — редакция от 5 октября 2026 г. Просим сделать это до начала сезона. Заявки приходят вам как раньше.',
    );
    expect(offerAskWords('needed', true)).toBe(
      'Оферта для партнёров обновилась: действует редакция от 5 октября 2026 г. Просим принять её до начала сезона. Заявки приходят вам как раньше.',
    );
  });

  it('менеджеру команды: принять может владелец; его самого ни о чём не просят', () => {
    expect(offerAskWords('owner_only', false)).toBe(
      'Оферта для партнёров (редакция от 5 октября 2026 г.) ещё не принята. Принять её может владелец кабинета — напомните ему. Заявки приходят как раньше.',
    );
    expect(offerAskWords('owner_only', true)).toContain('Оферта для партнёров обновилась');
    expect(offerAskWords('owner_only', true)).toContain('Принять её может владелец кабинета');
  });

  it('просьба не грозит и не обещает: ни блокировки, ни даты сезона, ни условий', () => {
    const all = [offerAskWords('needed', false), offerAskWords('needed', true), offerAskWords('owner_only', false), offerAskWords('owner_only', true), OFFER_ASK_TAG];
    for (const text of all) {
      expect(text).not.toMatch(/заблокир|закро|отключ|иначе|обязан|комисси|тариф|выплат|бесплатн|%/i);
      // Единственный год в словах — год редакции оферты.
      expect(text.replace(OFFER_EDITION, '')).not.toMatch(/\d/);
    }
    expect(OFFER_ASK_TAG).toBe('просим до начала сезона');
  });
});

describe('плашка в кабинете', () => {
  it('оферта не принята: просьба, ссылка на оферту, отметка и кнопка; без отметки кнопка не нажимается', async () => {
    const calls = stubOffer(asked('needed'));
    render(<PartnerOfferBanner />);
    const box = within(await screen.findByTestId('partner-offer-banner'));
    expect(banner()?.getAttribute('data-state')).toBe('needed');
    expect(box.getByText(/Примите оферту для партнёров — редакция от 5 октября 2026 г\./)).toBeTruthy();
    expect(box.getByRole('link', { name: 'Читать оферту' }).getAttribute('href')).toBe('/legal/offer');
    const button = box.getByRole('button', { name: 'Принять оферту' });
    expect(button).toHaveProperty('disabled', true);
    expect(box.getByText('Чтобы принять, поставьте отметку.')).toBeTruthy();
    fireEvent.click(box.getByRole('checkbox'));
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    await waitFor(() => expect(banner()?.getAttribute('data-state')).toBe('accepted'));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { url: '/api/hub/partner/offer', method: 'POST', body: { offer_accepted: true } },
    ]);
    expect(banner()?.textContent).toBe('Оферта принята: редакция от 5 октября 2026 г. Отметка записана.');
    // Просьбы и кнопки больше нет.
    expect(screen.queryByRole('button', { name: 'Принять оферту' })).toBeNull();
  });

  it('принимал прежнюю редакцию — сказано, что оферта обновилась', async () => {
    stubOffer(asked('needed', true));
    render(<PartnerOfferBanner />);
    expect((await screen.findByTestId('partner-offer-banner')).textContent).toContain('Оферта для партнёров обновилась: действует редакция от 5 октября 2026 г.');
  });

  it('дверь отказала — отказ показан, «принята» не говорится, просьба остаётся', async () => {
    stubOffer(asked('needed'), { status: 503, body: { success: false, error: 'Отметка не записана — попробуйте позже' } });
    render(<PartnerOfferBanner />);
    const box = within(await screen.findByTestId('partner-offer-banner'));
    fireEvent.click(box.getByRole('checkbox'));
    fireEvent.click(box.getByRole('button', { name: 'Принять оферту' }));
    expect((await box.findByRole('alert')).textContent).toBe('Отметка не записана — попробуйте позже');
    expect(banner()?.getAttribute('data-state')).toBe('needed');
  });

  it('менеджеру команды — строка без отметки и без кнопки', async () => {
    stubOffer(asked('owner_only'));
    render(<PartnerOfferBanner />);
    const box = within(await screen.findByTestId('partner-offer-banner'));
    expect(box.getByText(/Принять её может владелец кабинета — напомните ему\./)).toBeTruthy();
    expect(box.queryByRole('checkbox')).toBeNull();
    expect(box.queryByRole('button', { name: 'Принять оферту' })).toBeNull();
  });

  it.each([
    ['оферта принята', asked('accepted')],
    ['роль не сторона оферты', asked('not_needed')],
    ['журнал не прочитался', asked('unknown')],
    ['ответ не того вида', { success: true, data: { state: 'что-то новое' } }],
    ['сервер отказал', { status: 503, success: false }],
    ['не вошёл', { status: 401, success: false }],
  ])('плашки нет: %s', async (_name, answer) => {
    const calls = stubOffer(answer);
    render(<PartnerOfferBanner />);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/hub/partner/offer')).toBe(true));
    await Promise.resolve();
    expect(banner()).toBeNull();
  });

  it('обрыв сети — плашки нет: «не принята» на сбое было бы выдумкой', async () => {
    stubOffer(new Error('сеть'));
    render(<PartnerOfferBanner />);
    await Promise.resolve();
    await Promise.resolve();
    expect(banner()).toBeNull();
  });

  it('«позже» прячет просьбу до конца сессии вкладки; при следующем входе она появляется снова', async () => {
    stubOffer(asked('needed'));
    const first = render(<PartnerOfferBanner />);
    fireEvent.click(await screen.findByRole('button', { name: /Позже/ }));
    expect(banner()).toBeNull();
    // Та же вкладка, другая страница кабинета — по-прежнему скрыта.
    first.unmount();
    const calls = stubOffer(asked('needed'));
    const second = render(<PartnerOfferBanner />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await Promise.resolve();
    expect(banner()).toBeNull();
    // Следующий вход: хранилище сессии новое.
    second.unmount();
    window.sessionStorage.clear();
    stubOffer(asked('needed'));
    render(<PartnerOfferBanner />);
    expect(await screen.findByTestId('partner-offer-banner')).toBeTruthy();
  });

  it('хранилище недоступно — просьба показана: лишний показ честнее молчания', async () => {
    const broken = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('запрещено'); });
    stubOffer(asked('needed'));
    render(<PartnerOfferBanner />);
    expect(await screen.findByTestId('partner-offer-banner')).toBeTruthy();
    broken.mockRestore();
  });
});

describe('плашка стоит в кабинете каждой роли с заявками', () => {
  it.each([
    ['оператор', OperatorHubLayout],
    ['гид', GuideHubLayout],
    ['жильё', StayHubLayout],
    ['снаряжение', GearHubLayout],
    ['перевозчик и прокат', CarrierHubLayout],
  ])('%s', async (_name, Layout) => {
    stubOffer(asked('needed'));
    render(<Layout><main>экран</main></Layout>);
    expect(await screen.findByText('экран')).toBeTruthy();
    const box = within(await screen.findByTestId('partner-offer-banner'));
    expect(box.getByRole('button', { name: 'Принять оферту' })).toBeTruthy();
  });
});

describe('GET /api/hub/partner/offer — состояние просьбы', () => {
  const ask = async () => {
    const res = await GET(new NextRequest('http://localhost/api/hub/partner/offer'));
    return { status: res.status, body: await res.json() };
  };
  const owner = (over: Record<string, unknown> = {}) => ({
    partnerId: 'c8000000-0000-4000-8000-000000000001', category: 'operator', userId: 'u1', seat: 'owner', ...over,
  });
  beforeEach(() => { door.ctx = owner(); door.read.mockReset(); door.record.mockReset(); });

  it('не вошёл — отказ входа, журнал не читается', async () => {
    door.ctx = null;
    expect((await ask()).status).toBe(401);
    expect(door.read).not.toHaveBeenCalled();
  });

  it('акцепта нет — владельцу «нужно принять», карточка берётся из входа', async () => {
    door.read.mockResolvedValue(null);
    expect(await ask()).toEqual({ status: 200, body: { success: true, data: { state: 'needed', previous: false, edition: OFFER_EDITION } } });
    expect(door.read).toHaveBeenCalledWith('c8000000-0000-4000-8000-000000000001');
  });

  it('принята прежняя редакция — «нужно принять» с пометкой, что оферта обновилась', async () => {
    door.read.mockResolvedValue({ version: '2025-01-01', current: false, acceptedAt: '2025-02-01T00:00:00.000Z' });
    expect((await ask()).body.data).toEqual({ state: 'needed', previous: true, edition: OFFER_EDITION });
  });

  it('принята действующая редакция — просить не о чем', async () => {
    door.read.mockResolvedValue({ version: OFFER_VERSION, current: true, acceptedAt: '2026-11-24T00:00:00.000Z' });
    expect((await ask()).body.data.state).toBe('accepted');
  });

  it('менеджер команды — «принять может владелец»; принятое владельцем видит как принятое', async () => {
    door.ctx = owner({ seat: 'manager' });
    door.read.mockResolvedValue(null);
    expect((await ask()).body.data).toMatchObject({ state: 'owner_only', previous: false });
    door.read.mockResolvedValue({ version: OFFER_VERSION, current: true, acceptedAt: '2026-11-24T00:00:00.000Z' });
    expect((await ask()).body.data.state).toBe('accepted');
  });

  it('журнал не прочитался — «не знаю», а не «не принята»', async () => {
    door.read.mockResolvedValue('unknown');
    expect((await ask()).body.data.state).toBe('unknown');
  });

  it('агенту оферта не нужна — журнал не читается; остальные роли с заявками — стороны оферты', async () => {
    door.ctx = owner({ category: 'agent' });
    expect((await ask()).body.data.state).toBe('not_needed');
    expect(door.read).not.toHaveBeenCalled();
    door.read.mockResolvedValue(null);
    for (const category of ['operator', 'guide', 'transfer', 'stay', 'gear', 'cars']) {
      door.ctx = owner({ category });
      expect((await ask()).body.data.state, category).toBe('needed');
    }
  });

  it('состояние читается, но ничего не пишет', async () => {
    door.read.mockResolvedValue(null);
    await ask();
    expect(door.record).not.toHaveBeenCalled();
    expect(NextResponse).toBeDefined();
  });
});
