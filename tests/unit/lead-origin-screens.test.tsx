/**
 * «Откуда» видно на экранах лидов (слово владельца 08.11: «нужно писать,
 * откуда лиды — человек или ИИ и через какой инструмент: ТГ, MAX, MCP, A2A
 * или на сайте Кузьмич»).
 *
 * Судится рендером того, что видит человек: строка компонента, список и
 * доска админа, список и карточка лида у оператора. Подпись считает сервер
 * (lib/leads/origin) — экраны получают её полем `origin`; здесь она собрана
 * тем же правилом. До 08.11 карточка оператора показывала сырой адрес вроде
 * `mcp://vedar/booking`, а админка — сырой ключ источника.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { LeadOriginLine } from '@/components/leads/LeadOriginLine';
import { LeadsClient as AdminLeadsClient } from '@/app/hub/admin/leads/_LeadsClient';
import OperatorLeadsClient from '@/app/hub/operator/leads/_LeadsClient';
import LeadDetailClient from '@/app/hub/operator/leads/[id]/_LeadDetailClient';
import { leadOrigin } from '@/lib/leads/origin';

const A2A_BOOKING = { source: 'mcp', entry: 'a2a', tool: 'create_booking_request' };
const TG_CHAT = { source: 'mcp', entry: 'kuzmich-tg', tool: 'create_lead' };

const BASE = {
  id: 'l-1', name: 'Тест', phone: '+70000000000', email: null, comment: null, route_id: null, route_title: null,
  status: 'new', notes: null, ai_score: null, ai_summary: null, group_size: null, budget_rub: null, desired_dates: null,
  proposal_id: null, created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z', has_recipient: true,
};

/** Лид, как его отдаёт /api/leads: поля строки и подпись сервера. */
function apiLead(sourceUrl: string, sourceData: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { ...BASE, source_url: sourceUrl, source_data: sourceData, origin: leadOrigin({ source_url: sourceUrl, source_data: sourceData }), ...over };
}

function stubApi(leads: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.endsWith('/proposal')
      ? { proposal: null }
      : /\/api\/leads\/[^/?]+$/.test(u)
        ? { lead: leads[0], bookings: [] }
        : { leads, total: leads.length };
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

/** Рендер со своим кэшем SWR: иначе экран показал бы лида из прошлого теста. */
function renderFresh(ui: React.ReactElement) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('строка «Откуда»', () => {
  it('ИИ-агент: путь и что за заявка словами, отметка «agent»', () => {
    render(<LeadOriginLine origin={leadOrigin({ source_data: A2A_BOOKING })} />);
    const text = screen.getByText('Откуда: ИИ-агент · A2A · заявка на тур');
    expect(text.closest('[data-lead-actor]')?.getAttribute('data-lead-actor')).toBe('agent');
  });

  it('человек через чат Кузьмича — отметка «human»', () => {
    render(<LeadOriginLine origin={leadOrigin({ source_data: TG_CHAT })} />);
    const text = screen.getByText('Откуда: Человек · Кузьмич в Telegram · подбор тура');
    expect(text.closest('[data-lead-actor]')?.getAttribute('data-lead-actor')).toBe('human');
  });

  it('не записано — так и сказано, отметка «unknown»', () => {
    render(<LeadOriginLine origin={leadOrigin({})} />);
    const text = screen.getByText('Откуда: не записано');
    expect(text.closest('[data-lead-actor]')?.getAttribute('data-lead-actor')).toBe('unknown');
  });

  it('подписи нет — строки нет: экран происхождение не придумывает', () => {
    const { container } = render(<LeadOriginLine origin={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('админ: список и доска', () => {
  it('список — у карточки подпись «Откуда», сырого ключа источника нет', async () => {
    stubApi([apiLead('mcp://vedar/booking', A2A_BOOKING)]);
    renderFresh(<AdminLeadsClient />);
    expect(await screen.findByText('Откуда: ИИ-агент · A2A · заявка на тур')).toBeTruthy();
    expect(document.body.textContent).not.toContain('create_booking_request');
  });

  it('доска — у карточки та же подпись', async () => {
    localStorage.setItem('leads-view', 'kanban');
    stubApi([apiLead('mcp://vedar', TG_CHAT)]);
    renderFresh(<AdminLeadsClient />);
    await waitFor(() => expect(screen.getAllByText('Откуда: Человек · Кузьмич в Telegram · подбор тура').length).toBeGreaterThan(0));
  });
});

describe('оператор: список и карточка лида', () => {
  it('список — подпись у каждой заявки', async () => {
    stubApi([apiLead('mcp://vedar', TG_CHAT)]);
    renderFresh(<OperatorLeadsClient />);
    expect(await screen.findByText('Откуда: Человек · Кузьмич в Telegram · подбор тура')).toBeTruthy();
  });

  it('карточка заявки агента — подпись вместо сырого mcp://, строки «Страница» нет', async () => {
    stubApi([apiLead('mcp://vedar/booking', A2A_BOOKING)]);
    renderFresh(<LeadDetailClient leadId="l-1" />);
    expect(await screen.findByText('Откуда: ИИ-агент · A2A · заявка на тур')).toBeTruthy();
    expect(document.body.textContent).not.toContain('mcp://');
    expect(screen.queryByText(/^Страница:/)).toBeNull();
  });

  it('карточка заявки с формы сайта — подпись и адрес страницы', async () => {
    stubApi([apiLead('https://vedarai.ru/planner', { source: 'trip_planner' })]);
    renderFresh(<LeadDetailClient leadId="l-1" />);
    expect(await screen.findByText('Откуда: Человек · сайт, планер поездки')).toBeTruthy();
    expect(screen.getByText('Страница: https://vedarai.ru/planner')).toBeTruthy();
  });

  it('переключение на доску у оператора — подпись и там', async () => {
    stubApi([apiLead('mcp://vedar', A2A_BOOKING)]);
    renderFresh(<OperatorLeadsClient />);
    await screen.findByText('Откуда: ИИ-агент · A2A · заявка на тур');
    fireEvent.click(screen.getByRole('button', { name: 'Доска' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Доска' }).getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(screen.getAllByText('Откуда: ИИ-агент · A2A · заявка на тур').length).toBeGreaterThan(0));
  });
});
