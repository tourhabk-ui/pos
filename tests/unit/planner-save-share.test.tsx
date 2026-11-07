/**
 * /planner: сохранение помнит, что человек просил и о чём план предупреждал;
 * повтор сохранения — та же поездка; «Поделиться» сначала сохраняет (аудит
 * планировщика 07.11, волна 2.3–2.4: H6, H7, H10, H12). Сервер этих полей —
 * tests/unit/trip-write.test.ts, дубль заявки — lead-plan-fingerprint.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

import { PlannerClient } from '@/app/planner/_PlannerClient';
import { asPlanForLead, planLeadLines } from '@/lib/planner/plan-for-lead';

const day = (n: number, type: string, title: string, extra: Record<string, unknown> = {}) => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: type === 'activity' ? 'volcano' : type,
  priceFrom: 0, priceTo: 0, coords: [53.2, 158.6], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});
const WARNINGS = [{ type: 'mchs', severity: 'critical', message: 'Группу регистрируют в МЧС заранее' }];
const DAYS = [
  day(1, 'arrival', 'Прилёт днём'),
  day(2, 'activity', 'Авачинский вулкан', { dayWarnings: ['Только с гидом: сложный подъём'] }),
  day(3, 'departure', 'Сборы и вылет'),
];

/** Ответы сервера по очереди для POST /api/trips: сеть может «потерять» ответ. */
let tripPostReplies: Array<'lost' | 'ok'> = [];
beforeEach(() => {
  tripPostReplies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === '/api/trips' && init?.method === 'POST') {
      if (tripPostReplies.shift() === 'lost') throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ success: true, data: { id: '00000000-0000-4000-8000-000000000001' } }) } as Response;
    }
    if (/^\/api\/trips\/[^/]+$/.test(u) && init?.method === 'PATCH') {
      return { ok: true, json: async () => ({ success: true, data: { id: u.split('/').pop() } }) } as Response;
    }
    if (/^\/api\/trips\/[^/]+\/share$/.test(u)) {
      return { ok: true, json: async () => ({ success: true, shareUrl: 'https://vedarai.ru/trip/abc' }) } as Response;
    }
    const json = u.startsWith('/api/planner/recommend')
      ? { success: true, data: { zones: [], warnings: WARNINGS, itinerary: '', days: DAYS,
        priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] } } }
      : { success: true, data: [], tours: [] };
    return { ok: true, json: async () => json } as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));
const calls = (pred: (url: string, init?: RequestInit) => boolean) =>
  vi.mocked(fetch).mock.calls.filter(([u, i]) => pred(String(u), i as RequestInit | undefined));
const tripPosts = () => calls((u, i) => u === '/api/trips' && i?.method === 'POST').map(([, i]) => JSON.parse(String(i!.body)));

async function buildPlan() {
  render(<PlannerClient initialUserId="u-1" />);
  fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-01' } });
  fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-03' } });
  next(); next();
  // Шаг «Как хотите ехать»: жильё и машина напрокат.
  fireEvent.click(document.querySelector('[data-need="lodging"]')!);
  fireEvent.click(document.querySelector('[data-need="car"]')!);
  next();
  fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
  fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
  await screen.findByTestId('price-estimate');
}

describe('сохранение помнит просьбы и предупреждения (H6, H7)', () => {
  it('галочки, предупреждения плана и предупреждения дней уходят в поездку', async () => {
    await buildPlan();
    fireEvent.click(screen.getByRole('button', { name: /Сохранить маршрут/ }));
    await waitFor(() => expect(tripPosts()).toHaveLength(1));
    const body = tripPosts()[0]!;
    expect(body).toMatchObject({ needsLodging: true, needsCar: true, needsAirportTransfer: false, warnings: WARNINGS });
    expect(body.days[1].dayWarnings).toEqual(['Только с гидом: сложный подъём']);
  });

  it('заявка оператору говорит, что ещё нужно', async () => {
    await buildPlan();
    fireEvent.click(screen.getAllByRole('button', { name: /Запросить подробное предложение/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Тест' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+70000000000' } });
    fireEvent.click(document.getElementById('pd-consent-planner')!);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    const [, init] = calls((u) => u === '/api/leads')[0]!;
    const sd = JSON.parse(String(init!.body)).source_data;
    // План целиком: дни по порядку, а не их названия строкой.
    expect(sd.plan.days.map((d: { day: number; title: string }) => `${d.day} ${d.title}`))
      .toEqual(['1 Прилёт днём', '2 Авачинский вулкан', '3 Сборы и вылет']);
    expect(sd).not.toHaveProperty('day_plan');
    expect(sd.plan.needs).toEqual({ lodging: true, transfer: false, car: true });
    expect(planLeadLines(asPlanForLead(sd.plan)!)[0]).toMatch(/ещё нужно: жильё, машина напрокат$/);
    // Прежнее поле без читателя больше не отправляется: просьбы — в плане.
    expect(sd).not.toHaveProperty('needs_airport_transfer');
  });
});

describe('смета с машиной напрокат (E7, волна 2.5)', () => {
  it('отмечена машина, трансфер нет — трансфера аэропорта в смете нет, прокат назван', async () => {
    await buildPlan();
    const est = screen.getByTestId('price-estimate');
    expect(est.textContent).not.toMatch(/Трансферы аэропорта/);
    expect(est.textContent).toMatch(/Трансфер аэропорта не посчитан: в плане машина напрокат/);
  });
});

describe('повтор сохранения — та же поездка (H12)', () => {
  it('ответ потерялся — второй POST с тем же ключом; после успеха — правка, а не новая поездка', async () => {
    await buildPlan();
    tripPostReplies = ['lost', 'ok'];
    fireEvent.click(screen.getByRole('button', { name: /Сохранить маршрут/ }));
    await waitFor(() => expect(tripPosts()).toHaveLength(1));
    await screen.findByRole('button', { name: /Ошибка/ });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Ошибка/ })).toBeNull(), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить маршрут/ }));
    await waitFor(() => expect(tripPosts()).toHaveLength(2));
    const [first, second] = tripPosts();
    expect(first.saveKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.saveKey).toBe(first.saveKey);
    await screen.findByRole('button', { name: /Сохранено|Обновить маршрут/ });
    await waitFor(() => expect(screen.getByRole('button', { name: /Обновить маршрут/ })).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /Обновить маршрут/ }));
    await waitFor(() => expect(calls((u, i) => i?.method === 'PATCH')).toHaveLength(1));
    expect(tripPosts()).toHaveLength(2);
  }, 15000);

  it('браузер без криптографии — сохраняет без ключа, а не падает', async () => {
    await buildPlan();
    vi.stubGlobal('crypto', undefined);
    fireEvent.click(screen.getByRole('button', { name: /Сохранить маршрут/ }));
    await waitFor(() => expect(tripPosts()).toHaveLength(1));
    expect(tripPosts()[0]).not.toHaveProperty('saveKey');
    expect(await screen.findByRole('button', { name: /Сохранено|Обновить маршрут/ })).toBeTruthy();
  });
});

describe('«Поделиться» сначала сохраняет (H10)', () => {
  it('без сохранённой поездки — сохраняет и сразу даёт ссылку', async () => {
    await buildPlan();
    fireEvent.click(screen.getByTitle('Поделиться маршрутом'));
    expect(await screen.findByText('https://vedarai.ru/trip/abc', { exact: false })).toBeTruthy();
    expect(tripPosts()).toHaveLength(1);
    expect(calls((u) => u.endsWith('/share'))).toHaveLength(1);
  });

  it('с сохранённой — сначала правка с текущим планом, потом ссылка', async () => {
    await buildPlan();
    fireEvent.click(screen.getByRole('button', { name: /Сохранить маршрут/ }));
    await waitFor(() => expect(tripPosts()).toHaveLength(1));
    // Правка после сохранения: удалили день 2 — в ссылку уйдёт он свободным.
    fireEvent.click(screen.getAllByTitle('Удалить день')[0]!);
    fireEvent.click(screen.getByTitle('Поделиться маршрутом'));
    await screen.findByText('https://vedarai.ru/trip/abc', { exact: false });
    const order = vi.mocked(fetch).mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${String(u)}`)
      .filter((x) => x.includes('/api/trips'));
    const patchAt = order.findIndex((x) => x.startsWith('PATCH '));
    const shareAt = order.findIndex((x) => x.endsWith('/share'));
    expect(patchAt).toBeGreaterThan(-1);
    expect(shareAt).toBeGreaterThan(patchAt);
    const [, init] = calls((u, i) => i?.method === 'PATCH')[0]!;
    expect(JSON.parse(String(init!.body)).days[1].title).toBe('Свободный день');
  });
});
