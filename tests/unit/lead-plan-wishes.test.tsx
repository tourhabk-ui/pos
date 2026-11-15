/**
 * Слова туриста к плану Кузьмича — менеджеру в карточке лида (слово владельца
 * 15.11 «показывать менеджеру»).
 *
 * До этого черновик плана (`trip_plan_drafts.wishes`, миграция 1182) их
 * хранил, а не читал никто: правка плана берёт из черновика только дни и
 * параметры. Что держит сторож — вызовом и рендером:
 *   - черновик читается вместе со словами;
 *   - заявка из плана несёт их в `plan_wishes` (пусто — поля нет);
 *   - карточка лида в админке их показывает;
 *   - Telegram-уведомление их НЕ несёт: это свободный текст туриста, в нём
 *     бывает имя, а уведомление уходит и заглушкой без ПД.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { loadDraft } from '@/lib/planner/plan-drafts';
import { planSourceFields, type PlanAttach } from '@/lib/leads/plan-from-draft';
import { planForLead } from '@/lib/planner/plan-for-lead';
import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';
import { LeadsClient } from '@/app/hub/admin/leads/_LeadsClient';

const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const WORDS = 'вулканы и медведи, с детьми, без долгих переходов';
const PLAN = planForLead([], { adults: 2, children: [6], budgetTier: 'comfort', arrivalDate: '2027-08-02', departureDate: '2027-08-06' });
const attached = (wishes: string | null): PlanAttach => ({
  kind: 'attached', planId: ID, plan: PLAN, wishes,
  facts: { arrivalDate: '2027-08-02', departureDate: '2027-08-06', people: 3, tourDates: {}, tourDateNotes: {}, tourNoFree: {} },
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('черновик плана читается со словами туриста', () => {
  beforeEach(() => poolQuery.mockReset());

  it('loadDraft отдаёт wishes; нет их в строке — null', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: ID, params: {}, days: [], revision: 1, expires_at: '2027-08-01T00:00:00Z', wishes: WORDS }] });
    const r = await loadDraft(ID);
    expect(r.kind === 'found' && r.draft.wishes).toBe(WORDS);
    expect(String(poolQuery.mock.calls[0]![0])).toMatch(/\bwishes\b/);
    poolQuery.mockResolvedValueOnce({ rows: [{ id: ID, params: {}, days: [], revision: 1, expires_at: '2027-08-01T00:00:00Z', wishes: null }] });
    const none = await loadDraft(ID);
    expect(none.kind === 'found' && none.draft.wishes).toBeNull();
  });
});

describe('заявка из плана несёт слова туриста', () => {
  it('есть слова — plan_wishes, обрезано до 500', () => {
    expect(planSourceFields(attached(`  ${WORDS}  `))).toMatchObject({ plan_id: ID, plan_wishes: WORDS });
    expect((planSourceFields(attached('я'.repeat(800))) as { plan_wishes: string }).plan_wishes).toHaveLength(500);
  });

  it('слов нет — поля нет', () => {
    expect(planSourceFields(attached(null))).not.toHaveProperty('plan_wishes');
    expect(planSourceFields(attached('   '))).not.toHaveProperty('plan_wishes');
  });
});

describe('менеджер видит слова в карточке, Telegram — нет', () => {
  it('карточка лида в админке', async () => {
    const lead = {
      id: 'l-1', name: 'Тест', phone: '+70000000000', email: null, comment: null, route_id: null, route_title: null,
      status: 'new', notes: null, ai_score: null, ai_summary: null, group_size: null, budget_rub: null, desired_dates: null,
      proposal_id: null, created_at: '2026-11-15T00:00:00Z', updated_at: '2026-11-15T00:00:00Z', has_recipient: true,
      source_url: 'mcp://vedar', origin: null,
      source_data: { source: 'mcp', ...planSourceFields(attached(WORDS)) },
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ leads: [lead], total: 1 }) }) as Response));
    localStorage.clear();
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><LeadsClient /></SWRConfig>);
    fireEvent.click((await screen.findAllByText('Тест'))[0]!);
    expect((await screen.findByTestId('lead-plan-wishes')).textContent).toBe(`Слова туриста к плану: «${WORDS}»`);
  });

  it('уведомление в Telegram их не несёт', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const OLD = { ...process.env };
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '123';
    await notifyAdminNewLead({
      id: 'l-1', name: 'Тест', phone: '+70000000000', comment: null, routeTitle: null, sourceUrl: null,
      score: 60, labelRu: 'Тёплый', sourceData: { source: 'mcp', ...planSourceFields(attached(WORDS)) },
    });
    process.env = OLD;
    const sent = fetchMock.mock.calls.map((c) => String(((c as unknown[])[1] as RequestInit | undefined)?.body ?? '')).join('\n');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain('долгих переходов');
  });
});
