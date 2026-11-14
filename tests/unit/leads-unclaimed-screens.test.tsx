/**
 * Заявка без адресата на экранах кабинета, пока её не взяли (слово владельца
 * 14.11 «скрывать до взятия»).
 *
 * Судится рендером того, что видит человек, с ответом двери, какой она отдаёт
 * не взятую заявку (`hideUnclaimedContact`):
 *  - карточка: вместо телефона — объяснение и кнопка «Взять заявку»; разбора и
 *    «Завести бронь» нет; нажатие шлёт PATCH { claim: true }, после ответа
 *    карточка перечитывается и показывает телефон;
 *  - форма брони по ссылке «?lead=»: имя и телефон не подставляются, подпись
 *    «Имя — после взятия заявки» не становится именем туриста, сказано, что
 *    сначала заявку надо взять.
 * Двери и маска — tests/unit/leads-unclaimed-contact.test.ts; настоящий
 * PostgreSQL — сцена в tests/integration/tourist-cabinet.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/hub/operator/bookings',
  useSearchParams: () => new URLSearchParams(),
}));

import LeadDetailClient from '@/app/hub/operator/leads/[id]/_LeadDetailClient';
import BookingsManagementClient from '@/app/hub/operator/bookings/_BookingsManagementClient';
import { hideUnclaimedContact, HIDDEN_NAME, CONTACT_HIDDEN_NOTE, CLAIM_FIRST_TEXT } from '@/lib/leads/unclaimed-contact';
import { leadOrigin } from '@/lib/leads/origin';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const PHONE = '+79140001122';
const NAME = 'Иван Петров';
const SOURCE = { source: 'planner' };
const OWNER = { kind: 'owner', partnerId: 'P-OWN', claimUnowned: true } as const;

function row(operatorId: string | null) {
  return hideUnclaimedContact(OWNER, {
    id: LEAD_ID, operator_id: operatorId, name: NAME, phone: PHONE, email: null,
    comment: 'Хотим на вулкан в августе', route_id: null, route_title: null,
    status: 'new', notes: null, ai_score: null, ai_summary: null, group_size: 4, budget_rub: null, desired_dates: null,
    proposal_id: null, created_at: '2026-11-14T00:00:00Z', updated_at: '2026-11-14T00:00:00Z', has_recipient: false,
    source_url: null, source_data: SOURCE,
    origin: leadOrigin({ source_url: null, source_data: SOURCE, pd_consent_source: null }),
  });
}

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let claimed = false;

function stubApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ url: u, method, body });
    let json: unknown;
    if (method === 'PATCH' && u === `/api/leads/${LEAD_ID}`) {
      claimed = true;
      json = { success: true, lead: { id: LEAD_ID, status: 'new', notes: null } };
    } else if (u === `/api/leads/${LEAD_ID}`) {
      json = { lead: row(claimed ? 'P-OWN' : null), bookings: [] };
    } else if (u.endsWith('/proposal')) {
      json = { proposal: null };
    } else if (u.startsWith('/api/hub/operator/bookings')) {
      json = { success: true, data: [], pagination: { total: 0 } };
    } else if (u.startsWith('/api/hub/operator/tours')) {
      json = { success: true, data: [] };
    } else {
      json = {};
    }
    return { ok: true, status: 200, json: async () => json } as Response;
  }));
}

function renderFresh(ui: React.ReactElement) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  claimed = false;
  stubApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('карточка не взятой заявки', () => {
  it('ни имени, ни телефона; объяснение и «Взять заявку»; разбора и брони нет', async () => {
    renderFresh(<LeadDetailClient leadId={LEAD_ID} />);
    expect(await screen.findByText(CONTACT_HIDDEN_NOTE)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Взять заявку/ })).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(NAME);
    expect(text).toContain(HIDDEN_NAME);
    expect(screen.queryByRole('link', { name: /Завести бронь/ })).toBeNull();
    expect(text).toContain('Бронь — после взятия заявки');
    // Предложение по не взятой заявке не запрашивается: дверь ответила бы 409.
    expect(calls.some((c) => c.url.endsWith('/proposal'))).toBe(false);
    expect(document.querySelector(`a[href^="tel:"]`)).toBeNull();
  });

  it('«Взять заявку» шлёт PATCH { claim: true }, карточка открывает телефон', async () => {
    renderFresh(<LeadDetailClient leadId={LEAD_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: /Взять заявку/ }));
    await waitFor(() => expect(document.querySelector(`a[href="tel:${PHONE}"]`)).toBeTruthy());
    const patch = calls.filter((c) => c.method === 'PATCH');
    expect(patch).toEqual([{ url: `/api/leads/${LEAD_ID}`, method: 'PATCH', body: { claim: true } }]);
    expect(screen.getByText('Заявка ваша: имя и контакты открыты, другие компании её больше не видят.')).toBeTruthy();
    expect(screen.queryByText(CONTACT_HIDDEN_NOTE)).toBeNull();
    expect(screen.getByRole('link', { name: /Завести бронь/ })).toBeTruthy();
  });
});

describe('форма брони по ссылке из не взятой заявки', () => {
  it('имя и телефон не подставляются, сказано «сначала возьмите заявку»', async () => {
    window.history.replaceState(null, '', `/hub/operator/bookings?lead=${LEAD_ID}`);
    renderFresh(<BookingsManagementClient />);
    expect(await screen.findByText(CLAIM_FIRST_TEXT)).toBeTruthy();
    const nameInput = screen.getByPlaceholderText('Иванов Иван') as HTMLInputElement;
    expect(nameInput.value).toBe('');
    expect(document.body.textContent).not.toContain(HIDDEN_NAME);
  });

  it('у взятой заявки форма, как прежде, берёт имя и телефон из заявки', async () => {
    claimed = true;
    window.history.replaceState(null, '', `/hub/operator/bookings?lead=${LEAD_ID}`);
    renderFresh(<BookingsManagementClient />);
    await waitFor(() => expect((screen.getByPlaceholderText('Иванов Иван') as HTMLInputElement).value).toBe(NAME));
    expect(screen.queryByText(CLAIM_FIRST_TEXT)).toBeNull();
  });
});
