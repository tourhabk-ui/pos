/**
 * Черновик анкеты планера на устройстве (#3347, п. 10; слово владельца 15.11:
 * «Да, без заметок о здоровье»). Правило — вызовом lib/planner/form-draft,
 * восстановление и «Начать заново» — рендером страницы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
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
  FORM_DRAFT_KEY, DRAFT_SIGNOUT_KEY, EMPTY_FORM_DRAFT, clearFormDraft, parseFormDraft, serializeFormDraft,
  type PlannerFormDraft,
} from '@/lib/planner/form-draft';

const TODAY = '2026-11-15';
const OWNER = 'u-owner';
const NOW = new Date('2026-11-15T03:00:00Z');
const DRAFT: PlannerFormDraft = {
  ...EMPTY_FORM_DRAFT, places: ['volcano'], arrival: '2027-07-10', departure: '2027-07-16',
  adults: 5, childAges: [7], travelStyle: 'operator', needsLodging: true,
};

describe('правило черновика', () => {
  it('заметки о здоровье и контакты не записываются, даже если лежат в состоянии', () => {
    const state = { ...DRAFT, healthNotes: 'астма, колено', contactName: 'Тест', contactPhone: '+70000000000' };
    const raw = serializeFormDraft(state as PlannerFormDraft, OWNER, NOW);
    expect(raw).not.toMatch(/астма|healthNotes|contact|\+70000000000|Тест/);
    expect(parseFormDraft(raw, TODAY, OWNER, NOW)).toEqual(DRAFT);
  });

  it('прошедшие даты не возвращаются; старше 30 дней — черновика нет; битое — нет', () => {
    const past = serializeFormDraft({ ...DRAFT, arrival: '2026-11-01', departure: '2026-11-05' }, OWNER, NOW);
    expect(parseFormDraft(past, TODAY, OWNER, NOW)).toMatchObject({ arrival: '', departure: '', adults: 5 });
    const old = serializeFormDraft(DRAFT, OWNER, new Date('2026-10-01T00:00:00Z'));
    expect(parseFormDraft(old, TODAY, OWNER, NOW)).toBeNull();
    expect(parseFormDraft('{не json', TODAY, OWNER, NOW)).toBeNull();
    expect(parseFormDraft(JSON.stringify({ savedAt: NOW.toISOString(), owner: OWNER, draft: { adults: 999, fitnessLevel: 'god', childAges: [40] } }), TODAY, OWNER, NOW))
      .toMatchObject({ adults: 2, fitnessLevel: 'moderate', childAges: [null] });
  });

  it('черновик отдаётся только своему владельцу (общее устройство, 16.11)', () => {
    const raw = serializeFormDraft(DRAFT, OWNER, NOW);
    expect(parseFormDraft(raw, TODAY, 'u-other', NOW)).toBeNull();
    expect(parseFormDraft(raw, TODAY, null, NOW)).toBeNull();
    expect(parseFormDraft(raw, TODAY, '', NOW)).toBeNull();
    // Черновик до 16.11 владельца не несёт — не отдаётся никому.
    const unowned = JSON.stringify({ savedAt: NOW.toISOString(), draft: JSON.parse(raw).draft });
    expect(parseFormDraft(unowned, TODAY, OWNER, NOW)).toBeNull();
  });
});

describe('страница /planner', () => {
  beforeEach(() => {
    params = new URLSearchParams('');
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: [], tours: [] }) } as Response)));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

  const stored = () => parseFormDraft(localStorage.getItem(FORM_DRAFT_KEY), '2000-01-01', OWNER);

  it('черновик с устройства возвращается и сказано, что без заметок о здоровье', async () => {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft(DRAFT, OWNER));
    render(<PlannerClient initialUserId={OWNER} />);
    expect((await screen.findByText(/Анкета восстановлена с этого устройства \(без заметок о здоровье\)/))).toBeTruthy();
    await waitFor(() => expect(stored()).toMatchObject({ adults: 5, places: ['volcano'], travelStyle: 'operator' }));
  });

  it('«Начать заново» стирает черновик и анкету', async () => {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft(DRAFT, OWNER));
    render(<PlannerClient initialUserId={OWNER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Начать заново' }));
    await waitFor(() => expect(screen.queryByText(/Анкета восстановлена/)).toBeNull());
    await waitFor(() => expect(stored()).toMatchObject({ adults: 2, places: [], travelStyle: 'mixed', needsLodging: false }));
  });

  it('ссылка с выбором (из чата, с главной) черновик не перебивает', async () => {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft(DRAFT, OWNER));
    params = new URLSearchParams('adults=3');
    render(<PlannerClient initialUserId={OWNER} />);
    await waitFor(() => expect(stored()).toMatchObject({ adults: 3 }));
    expect(screen.queryByText(/Анкета восстановлена/)).toBeNull();
  });

  it('чужой черновик на этом устройстве не возвращается и затирается анкетой вошедшего', async () => {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft({ ...DRAFT, seasickness: true, mobilityLevel: 'wheelchair' }, 'u-prev'));
    render(<PlannerClient initialUserId={OWNER} />);
    await waitFor(() => expect(stored()).toMatchObject({ adults: 2, places: [], seasickness: false, mobilityLevel: 'full' }));
    expect(screen.queryByText(/Анкета восстановлена/)).toBeNull();
    expect(parseFormDraft(localStorage.getItem(FORM_DRAFT_KEY), '2000-01-01', 'u-prev')).toBeNull();
  });

  it('без известного вошедшего черновик не читается и не пишется', async () => {
    const before = serializeFormDraft(DRAFT, OWNER);
    localStorage.setItem(FORM_DRAFT_KEY, before);
    render(<PlannerClient />);
    await screen.findAllByRole('button');
    expect(screen.queryByText(/Анкета восстановлена/)).toBeNull();
    expect(localStorage.getItem(FORM_DRAFT_KEY)).toBe(before);
  });

  // Ревью безопасности PR 3452: открытая вкладка держит старый вход до
  // перезагрузки и без остановки записала бы черновик обратно после «Выйти».
  async function openedWithDraft() {
    localStorage.setItem(FORM_DRAFT_KEY, serializeFormDraft({ ...DRAFT, seasickness: true }, OWNER));
    render(<PlannerClient initialUserId={OWNER} />);
    await screen.findByText(/Анкета восстановлена/);
  }
  // «Начать заново» меняет анкету — без остановки эффект записал бы её.
  async function editAndSettle() {
    fireEvent.click(await screen.findByRole('button', { name: 'Начать заново' }));
    await waitFor(() => expect(screen.queryByText(/Анкета восстановлена/)).toBeNull());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }

  it('«Выйти» в другой вкладке: открытый планер черновик больше не пишет', async () => {
    await openedWithDraft();
    act(() => {
      localStorage.removeItem(FORM_DRAFT_KEY);
      localStorage.setItem(DRAFT_SIGNOUT_KEY, '1');
      window.dispatchEvent(new StorageEvent('storage', { key: DRAFT_SIGNOUT_KEY, newValue: '1' }));
    });
    await editAndSettle();
    expect(localStorage.getItem(FORM_DRAFT_KEY)).toBeNull();
  });

  it('«Выйти» в этой же вкладке: планер черновик больше не пишет', async () => {
    await openedWithDraft();
    act(() => { clearFormDraft(); });
    await editAndSettle();
    expect(localStorage.getItem(FORM_DRAFT_KEY)).toBeNull();
  });

  it('событие чужого ключа хранилища запись не останавливает', async () => {
    await openedWithDraft();
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '1' })); });
    await editAndSettle();
    expect(stored()).toMatchObject({ adults: 2, places: [] });
  });

  it('планер, открытый после выхода (новый вход), черновик пишет', async () => {
    clearFormDraft();
    render(<PlannerClient initialUserId={OWNER} />);
    await waitFor(() => expect(stored()).toMatchObject({ adults: 2, places: [] }));
  });
});
