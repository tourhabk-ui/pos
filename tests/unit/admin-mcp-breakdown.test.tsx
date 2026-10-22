// @vitest-environment jsdom
/**
 * Числа на странице «Запросы через MCP» — кнопки, и по нажатию раскрывается
 * расшифровка по суткам: кто звал и о чём (слово владельца 22.10). Рендером,
 * как смотрит владелец; SQL расшифровки — tests/integration/admin-day-counts.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const DAY = { day: '2026-10-22', calls: 7, errors: 1, failures: 1, refusals: 1, caller_days: 3, self: 1, probe: 1 };
const PAGE = {
  by_tool_30d: [{ tool: 'get_place_info', calls_7d: 2, errors_7d: 0, calls_30d: 2, errors_30d: 0, failures_30d: 0, failures_unsplit_30d: 0, refusals_30d: 0, avg_ms: 10, max_ms: 20, caller_days_30d: 1 }],
  daily_30d: [{ ...DAY, day: '2026-10-21', calls: 14 }, DAY],
  errors_by_kind_30d: [], errors_detail_30d: [], unknown_tools_30d: [], by_client_30d: [],
  origins_30d: { external: 2017, self: 0, probe: 969, self_since: null, refused_since: null },
  window_note: '',
};
const BREAKDOWN = {
  success: true,
  data: {
    from: '2026-10-22', to: '2026-10-22',
    days: [{
      day: '2026-10-22', calls: 7, callers: 3,
      clients: [
        { client: 'claude-ai', kind: 'представился', origin: 'external', region: null, calls: 4, callers: 1, failures: 0, refusals: 1,
          tools: [{ tool: 'get_place_info', calls: 2 }, { tool: 'create_lead', calls: 1 }, { tool: 'get_weather', calls: 1 }],
          topics: [{ tool: 'get_place_info', key: 'name', value: 'Мутновский', n: 2 }, { tool: 'create_lead', key: 'name', value: null, n: 1 }],
          topics_more: 3 },
        { client: 'не представился', kind: 'неизвестно', origin: 'external', region: null, calls: 1, callers: 1, failures: 0, refusals: 0,
          tools: [{ tool: 'safety_status', calls: 1 }], topics: [{ tool: 'safety_status', key: null, value: null, n: 1 }], topics_more: 0 },
      ],
    }],
  },
};

function stub(breakdown: unknown = BREAKDOWN) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.startsWith('/api/admin/analytics/mcp/breakdown') ? breakdown : PAGE;
    return { ok: true, status: 200, json: async () => body };
  }));
  return calls;
}

async function openPage() {
  const { default: Page } = await import('@/app/hub/admin/mcp/page');
  render(React.createElement(Page));
  return screen.findByRole('button', { name: /Внешних сегодня/ });
}

describe('/hub/admin/mcp — расшифровка по нажатию на число', () => {
  it('«Внешних сегодня»: кнопка раскрывает, кто звал, сколько раз, инструменты и о чём; повторно — сворачивает', async () => {
    const calls = stub();
    const btn = await openPage();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const panel = await screen.findByRole('region', { name: /Внешних сегодня: расшифровка/ });
    expect(calls).toContain('/api/admin/analytics/mcp/breakdown?origin=external&outcome=all&days=1&skip=0');
    const p = within(panel);
    await p.findByText('claude-ai');
    expect(p.getByText(/4 вызова · разных вызывающих 1/)).toBeTruthy();
    expect(p.getByText('Мутновский')).toBeTruthy();
    expect(p.getByText(/get_place_info, name ×2/)).toBeTruthy();
    expect(p.getByText('и ещё тем: 3')).toBeTruthy();
    expect(p.getByText(/сбоев 0 · отказов 1/)).toBeTruthy();
    // У вызова без значения — честное «не записано», а не пустота.
    expect(p.getByText(/О чём спрашивали — не записано/)).toBeTruthy();
    expect(p.getByText('не представился', { selector: 'span.text-sm' })).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByRole('region', { name: /Внешних сегодня: расшифровка/ })).toBeNull();
  });

  it('каждое число зовёт свою расшифровку: вчера — пропуск суток, свои/проверки, 30 дней, сбои и отказы', async () => {
    const calls = stub();
    await openPage();
    const expectations: Array<[RegExp, string]> = [
      [/Внешних вчера/, 'origin=external&outcome=all&days=1&skip=1'],
      [/Сегодня своих \/ проверок/, 'origin=own&outcome=all&days=1&skip=0'],
      [/Своих \(метка владельца\)/, 'origin=self&outcome=all&days=30&skip=0'],
      [/Проверок \(смоук, пробы, curl\)/, 'origin=probe&outcome=all&days=30&skip=0'],
      [/Внешних за 7 дней/, 'origin=external&outcome=all&days=7&skip=0'],
      [/Сбоев за 30 дней/, 'origin=external&outcome=failure&days=30&skip=0'],
      [/Отказов за 30 дней/, 'origin=external&outcome=refusal&days=30&skip=0'],
    ];
    for (const [name, query] of expectations) {
      fireEvent.click(screen.getByRole('button', { name }));
      await screen.findByRole('region', { name: new RegExp(`${name.source}: расшифровка`) });
      expect(calls).toContain(`/api/admin/analytics/mcp/breakdown?${query}`);
    }
    // Оба «Внешних за 30 дней» — одна и та же расшифровка.
    for (const b of screen.getAllByRole('button', { name: /Внешних за 30 дней/ })) {
      fireEvent.click(b);
      expect(calls).toContain('/api/admin/analytics/mcp/breakdown?origin=external&outcome=all&days=30&skip=0');
    }
  });

  it('отказ расшифровки виден словами; пустые сутки — «таких вызовов нет»', async () => {
    stub({ success: false, error: 'Не удалось построить расшифровку MCP' });
    fireEvent.click(await openPage());
    expect(await screen.findByText('Не удалось построить расшифровку MCP')).toBeTruthy();
    cleanup();
    stub({ success: true, data: { from: '2026-10-22', to: '2026-10-22', days: [] } });
    fireEvent.click(await openPage());
    expect(await screen.findByText('За эти сутки таких вызовов нет.')).toBeTruthy();
  });
});
