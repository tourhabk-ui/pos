/**
 * Заявка, которую отменил клиент (1427), на экранах продавца и администратора.
 *
 * Судится рендером того, что видит человек:
 *  - список и карточка лида у оператора, список у администратора — статус
 *    словами «Отменена клиентом», а не сырым `cancelled`;
 *  - в карточке оператора кнопки смены статуса выключены и рядом сказано
 *    почему: нажатие по такой заявке ничего не изменило бы, а «Статус изменён»
 *    было бы неправдой;
 *  - у живой заявки кнопки работают как раньше.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { LeadsClient as AdminLeadsClient } from '@/app/hub/admin/leads/_LeadsClient';
import OperatorLeadsClient from '@/app/hub/operator/leads/_LeadsClient';
import LeadDetailClient from '@/app/hub/operator/leads/[id]/_LeadDetailClient';
import { leadOrigin } from '@/lib/leads/origin';

const SOURCE = { source: 'mcp', entry: 'kuzmich-max', tool: 'create_booking_request' };

function lead(status: string) {
  return {
    id: 'l-1', name: 'Тест', phone: '+70000000000', email: null, comment: null, route_id: null, route_title: null,
    status, notes: null, ai_score: null, ai_summary: null, group_size: null, budget_rub: null, desired_dates: null,
    proposal_id: null, created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z', has_recipient: true,
    source_url: 'mcp://vedar/booking', source_data: SOURCE,
    origin: leadOrigin({ source_url: 'mcp://vedar/booking', source_data: SOURCE, pd_consent_source: null }),
  };
}

function stubApi(row: ReturnType<typeof lead>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.endsWith('/proposal')
      ? { proposal: null }
      : /\/api\/leads\/[^/?]+$/.test(u)
        ? { lead: row, bookings: [] }
        : { leads: [row], total: 1 };
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

function renderFresh(ui: React.ReactElement) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);
}

/** Кнопки блока «Статус и действия» в карточке оператора. */
const STATUS_BUTTONS = ['Контакт установлен', 'Квалифицирован', 'Предложение отправлено', 'Конвертирован', 'Потерян'];
const statusButtons = () => screen.getAllByRole('button').filter((b) => STATUS_BUTTONS.includes(b.textContent?.trim() ?? ''));

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('отменённая клиентом заявка на экранах', () => {
  it('оператор, список — статус словами', async () => {
    stubApi(lead('cancelled'));
    renderFresh(<OperatorLeadsClient />);
    expect(await screen.findByText('Отменена клиентом')).toBeTruthy();
    expect(document.body.textContent).not.toContain('cancelled');
  });

  it('администратор, список — статус словами', async () => {
    stubApi(lead('cancelled'));
    renderFresh(<AdminLeadsClient />);
    await waitFor(() => expect(screen.getAllByText('Отменена клиентом').length).toBeGreaterThan(0));
  });

  it('оператор, карточка — статус словами, кнопки смены статуса выключены, причина названа', async () => {
    stubApi(lead('cancelled'));
    renderFresh(<LeadDetailClient leadId="l-1" />);
    expect((await screen.findAllByText('Отменена клиентом')).length).toBeGreaterThan(0);
    const buttons = statusButtons();
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(STATUS_BUTTONS);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled, b.textContent ?? '').toBe(true);
    expect(screen.getByText('Заявку отменил клиент — статус не меняется.')).toBeTruthy();
  });

  it('оператор, карточка живой заявки — кнопки включены, строки про отмену нет', async () => {
    stubApi(lead('new'));
    renderFresh(<LeadDetailClient leadId="l-1" />);
    await screen.findByText('Статус и действия');
    const buttons = statusButtons();
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(STATUS_BUTTONS);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled, b.textContent ?? '').toBe(false);
    expect(screen.queryByText('Заявку отменил клиент — статус не меняется.')).toBeNull();
  });
});
