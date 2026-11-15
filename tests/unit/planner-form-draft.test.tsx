/**
 * Черновик анкеты планера на устройстве (#3347, п. 10; слово владельца 15.11:
 * «Да, без заметок о здоровье»). Правило — вызовом lib/planner/form-draft,
 * восстановление и «Начать заново» — рендером страницы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

let params = new URLSearchParams('');
vi.mock('next/navigation', () => ({
  useSearchParams: () => params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

import { PlannerClient } from '@/app/planner/_PlannerClient';
import {
  FORM_DRAFT_KEY, EMPTY_FORM_DRAFT, parseFormDraft, serializeFormDraft, type PlannerFormDraft,
} from '@/lib/planner/form-draft';

const TODAY = '2026-11-15';
const NOW = new Date('2026-11-15T03:00:00Z');
const DRAFT: PlannerFormDraft = {
  ...EMPTY_FORM_DRAFT, places: ['volcano'], arrival: '2027-07-10', departure: '2027-07-16',
  adults: 5, childAges: [7], travelStyle: 'operator', needsLodging: true,
};

describe('правило черновика', () => {
  it('заметки о здоровье и контакты не записываются, даже если лежат в состоянии', () => {
    const state = { ...DRAFT, healthNotes: 'астма, колено', contactName: 'Тест', contactPhone: '+70000000000' };
    const raw = serializeFormDraft(state as PlannerFormDraft, NOW);
    expect(raw).not.toMatch(/астма|healthNotes|contact|\+70000000000|Тест/);
    expect(parseFormDraft(raw, TODAY, NOW)).toEqual(DRAFT);
  });

  it('прошедшие даты не возвращаются; старше 30 дней — черновика нет; битое — нет', () => {
    const past = serializeFormDraft({ ...DRAFT, arrival: '2026-11-01', departure: '2026-11-05' }, NOW);
    expect(parseFormDraft(past, TODAY, NOW)).toMatchObject({ arrival: '', departure: '', adults: 5 });
    const old = serializeFormDraft(DRAFT, new Date('2026-10-01T00:00:00Z'));
    expect(parseFormDraft(old, TODAY, NOW)).toBeNull();
    expect(parseFormDraft('{не json', TODAY, NOW)).toBeNull();
    expect(parseFormDraft(JSON.stringify({ savedAt: NOW.toISOString(), draft: { adults: 999, fitnessLevel: 'god', childAges: [40] } }), TODAY, NOW))
      .toMatchObject({ adults: 2, fitnessLevel: 'moderate', childAges: [null] });
  });
});

describe('страница /planner', () => {
  beforeEach(() => {
    params = new URLSearchParams('');
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: [], tours: [] }) } as Response)));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  const stored = () => parseFormDraft(localStorage.getItem(FORM_DRAFT_KEY), '2000-01-01');

  it('черновик с устройства возвращается и сказано, что без заметок о здоровье', async () => {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft(DRAFT));
    render(<PlannerClient />);
    expect((await screen.findByText(/Анкета восстановлена с этого устройства \(без заметок о здоровье\)/))).toBeTruthy();
    await waitFor(() => expect(stored()).toMatchObject({ adults: 5, places: ['volcano'], travelStyle: 'operator' }));
  });

  it('«Начать заново» стирает черновик и анкету', async () => {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft(DRAFT));
    render(<PlannerClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Начать заново' }));
    await waitFor(() => expect(screen.queryByText(/Анкета восстановлена/)).toBeNull());
    await waitFor(() => expect(stored()).toMatchObject({ adults: 2, places: [], travelStyle: 'mixed', needsLodging: false }));
  });

  it('ссылка с выбором (из чата, с главной) черновик не перебивает', async () => {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft(DRAFT));
    params = new URLSearchParams('adults=3');
    render(<PlannerClient />);
    await waitFor(() => expect(stored()).toMatchObject({ adults: 3 }));
    expect(screen.queryByText(/Анкета восстановлена/)).toBeNull();
  });
});
