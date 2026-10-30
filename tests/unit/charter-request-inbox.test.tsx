/**
 * «Входящие» перевозчика на сайте — рендером (#2862 этап A): заявка на машину
 * стоит в списке с кнопками «Беру» / «Не могу», нажатие уходит в дверь сайта
 * тем же ответом, что кнопка в MAX; у оператора таких кнопок нет. Ответ
 * «уже записан» (409) — не ошибка ввода.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import { InboxScreen } from '@/components/crm/InboxScreen';
import { CRM_CHARTER_ANSWER_API, CRM_INBOX_API, CRM_RIDE_OUTCOME_API } from '@/components/crm/api';

const LEAD = '33333333-3333-4333-8333-333333333333';

function inbox(category: 'transfer' | 'operator', kind: 'charter_request' | 'charter_ride' | 'lead') {
  return {
    success: true,
    data: {
      category,
      items: [{ kind, id: LEAD, created_at: '2026-10-30T00:00:00Z', title: 'Вулкан Горелый', date: '2026-11-10', people: 10, contact_id: null, contact_name: null, waiting_minutes: 150 }],
      failed: [], response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
      chat: { state: 'none' }, not_here: [],
    },
  };
}

let calls: Array<{ url: string; method: string; body: unknown }> = [];
let answerReply: { status: number; body: unknown } = { status: 200, body: { success: true, outcome: 'charter_take', message: 'Ваш ответ: беру. Машина заявкой не закрепляется. Заказчику сообщил.' } };
let inboxBody: unknown = inbox('transfer', 'charter_request');

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (u.startsWith(CRM_INBOX_API)) return { ok: true, status: 200, json: async () => inboxBody } as Response;
    if (u.startsWith(CRM_CHARTER_ANSWER_API) || u.startsWith(CRM_RIDE_OUTCOME_API)) return { ok: answerReply.status < 300, status: answerReply.status, json: async () => answerReply.body } as Response;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«Входящие» перевозчика', () => {
  it('заявка на машину с «Беру» / «Не могу»; «Беру» уходит в дверь сайта и показывает ответ', async () => {
    render(<InboxScreen />);
    await screen.findByText('Вулкан Горелый');
    expect(screen.getByText('Заявка на машину')).toBeTruthy();
    expect(screen.getByText(/машина заявкой не закрепляется/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Беру' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${CRM_CHARTER_ANSWER_API}/${LEAD}/answer`);
    expect(post.body).toEqual({ answer: 'take' });
    expect((await screen.findByRole('status')).textContent).toMatch(/Заказчику сообщил/);
  });

  it('«уже записан» — предупреждение, не ошибка; «Не могу» шлёт decline', async () => {
    answerReply = { status: 409, body: { success: false, outcome: 'already', error: 'Ответ уже записан: беру.' } };
    render(<InboxScreen />);
    await screen.findByText('Вулкан Горелый');
    fireEvent.click(screen.getByRole('button', { name: 'Не могу' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('уже записан');
    expect(status.className).toContain('--warning');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ answer: 'decline' });
  });

  it('«Поездка состоялась?» (#2862 этап B): кнопки исхода, «состоялась» уходит в дверь сайта, итог — над списком', async () => {
    inboxBody = inbox('transfer', 'charter_ride');
    answerReply = { status: 200, body: { success: true, outcome: 'held', message: 'Записано: поездка состоялась. Заказчику отправлена ссылка на отзыв о вас.' } };
    render(<InboxScreen />);
    await screen.findByText('Вулкан Горелый');
    expect(screen.getByText('Поездка состоялась?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Беру' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Поездка состоялась' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${CRM_RIDE_OUTCOME_API}/${LEAD}/outcome`);
    expect(post.body).toEqual({ outcome: 'held' });
    expect((await screen.findByRole('status')).textContent).toMatch(/ссылка на отзыв/);
  });

  it('у оператора заявка на подбор — без кнопок перевозчика', async () => {
    inboxBody = inbox('operator', 'lead');
    render(<InboxScreen />);
    await screen.findByText('Вулкан Горелый');
    expect(screen.queryByRole('button', { name: 'Беру' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Не могу' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Поездка состоялась' })).toBeNull();
  });
});
