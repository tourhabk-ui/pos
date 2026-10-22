// @vitest-environment jsdom
/**
 * «За сутки по Камчатке» на обзоре админки: люди, MCP, A2A, Кузьмич (слово
 * владельца 22.10) — рендером. Каждое число — ссылка на свою страницу;
 * несчитанное — «не загрузилось», а не ноль (§4.0). SQL — в
 * tests/integration/admin-day-counts.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stub(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
}

const DATA = {
  today: '2026-10-22', yesterday: '2026-10-21',
  people: { ok: true, today: { visitors: 41, views: 120, bot_views: 300 }, yesterday: { visitors: 38, views: 99, bot_views: 250 } },
  mcp: { ok: true, today: { calls: 116, callers: 46 }, yesterday: { calls: 103, callers: 16 } },
  a2a: { ok: true, today: { requests: 5, callers: 2 }, yesterday: { requests: 0, callers: 0 } },
  kuzmich: { ok: true, today: { answers: 9, by_surface: { web: 4, 'web-stream': 1, telegram: 3, a2a: 1 } }, yesterday: { answers: 3, by_surface: { a2a: 2, telegram: 1 } } },
};

async function show() {
  const { default: Strip } = await import('@/app/hub/admin/_DaySummary');
  render(React.createElement(Strip));
  return screen.findByRole('region', { name: 'За сутки' });
}

describe('обзор админки — числа суток', () => {
  it('четыре числа с вчерашним рядом, каждое ведёт на свою страницу', async () => {
    stub({ success: true, data: DATA });
    const region = within(await show());
    const link = (name: RegExp) => region.getByRole('link', { name });
    expect(link(/^Люди/).getAttribute('href')).toBe('/hub/admin/traffic');
    expect(link(/^MCP/).getAttribute('href')).toBe('/hub/admin/mcp');
    expect(link(/^A2A/).getAttribute('href')).toBe('/hub/admin/a2a');
    expect(link(/^Кузьмич/).getAttribute('href')).toBe('/hub/admin/ai-usage?tab=kuzmich');
    expect(within(link(/^Люди/)).getByText('41')).toBeTruthy();
    expect(within(link(/^Люди/)).getByText('вчера 38')).toBeTruthy();
    expect(within(link(/^MCP/)).getByText('116')).toBeTruthy();
    expect(within(link(/^MCP/)).getByText(/разных вызывающих 46/)).toBeTruthy();
    expect(within(link(/^A2A/)).getByText('5')).toBeTruthy();
    expect(within(link(/^A2A/)).getByText('вчера 0')).toBeTruthy();
    // Сайт и его потоковый вход — одной строкой; по убыванию.
    expect(within(link(/^Кузьмич/)).getByText('сайт 5 · Telegram 3 · A2A 1')).toBeTruthy();
    // И где были вчерашние ответы (вопрос владельца 22.10: «вчера 3 ответа а в
    // переписках нету кто откуда»).
    expect(within(link(/^Кузьмич/)).getByText('вчера: A2A 2 · Telegram 1')).toBeTruthy();
    expect(region.getByText(/ваши разговоры с ним в числе/)).toBeTruthy();
  });

  it('несчитанное число — «не загрузилось», остальные на месте', async () => {
    stub({ success: true, data: { ...DATA, a2a: { ok: false, error: 'не загрузилось' } } });
    const region = within(await show());
    expect(within(region.getByRole('link', { name: /^A2A/ })).getByText('не загрузилось')).toBeTruthy();
    expect(within(region.getByRole('link', { name: /^MCP/ })).getByText('116')).toBeTruthy();
  });

  it('отказ всей сводки — словами, без плиток с нулями', async () => {
    stub({ success: false, error: 'Нет доступа' });
    const { default: Strip } = await import('@/app/hub/admin/_DaySummary');
    render(React.createElement(Strip));
    expect(await screen.findByText('Нет доступа')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
