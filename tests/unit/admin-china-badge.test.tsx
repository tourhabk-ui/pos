// @vitest-environment jsdom
/**
 * Метка «КНР» видна человеку на обеих админ-страницах (владелец 13.10) —
 * отрисовка с подменённым ответом среза, как смотрит владелец.
 * Данные и роды — tests/unit/mcp-china-clients.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
}

describe('/hub/admin/a2a — «Кто приходит» и «По MCP»', () => {
  it('у агента и клиента из реестра КНР стоит метка, у остальных нет', async () => {
    const agent = { is_self: false, kind: 'external', requests: 2, sends: 2, text_sends: 1, tool_sends: 1, completed: 2, rejected: 0, failed: 0, protocol_errors: 0, card_reads: 0, dialogs: 1, caller_days: 1, versions: ['1.0'], bindings: ['jsonrpc'], first_seen: '2026-10-13 08:00', last_seen: '2026-10-13 08:05' };
    stubFetch({
      success: true, window_days: 30, generated_at: '2026-10-13T11:00:00Z',
      a2a: { ok: true, since: '2026-10-12', total_all_time: 4, total_window: 4, recent_limit: 50, by_day: [], by_tool: [], recent: [],
        by_agent: [
          { agent: 'CherryStudio', ua_family: 'cherry-studio', region: 'КНР', ...agent },
          { agent: 'BrickBlueBot', ua_family: 'неизвестен', region: null, ...agent },
        ] },
      mcp: { ok: true, clients: [
        { client: 'Qwen Code', kind: 'представился', origin: 'external', region: 'КНР', caller_days: 3, days: 2, first_seen: '2026-10-12', last_seen: '2026-10-13 10:00' },
        { client: 'claude-ai', kind: 'представился', origin: 'external', region: null, caller_days: 9, days: 5, first_seen: '2026-10-01', last_seen: '2026-10-13 09:00' },
      ] },
      entries: { ok: true, since: '2026-10-12', total_all_time: 0, total_window: 0, by_family: [] },
      dialogs: { ok: true, since: null, total: 0, retention_days: 90, limit: 50, items: [] },
      degraded: [], note: '',
    });
    const { default: A2aClient } = await import('@/app/hub/admin/a2a/_A2aClient');
    render(React.createElement(A2aClient));
    await screen.findByText('CherryStudio');
    await screen.findByText('Qwen Code');
    expect(screen.getAllByText('КНР')).toHaveLength(2);
    // Метка стоит в строке своего клиента, а не где-то на странице.
    expect(screen.getByText('Qwen Code').parentElement?.textContent).toContain('КНР');
    expect(screen.getByText('claude-ai').parentElement?.textContent).not.toContain('КНР');
  });
});

describe('/hub/admin/mcp — «Кто звал»', () => {
  it('клиент из реестра КНР помечен, прочие нет', async () => {
    stubFetch({
      by_tool_30d: [{ tool: 'get_tours', calls_7d: 3, errors_7d: 0, calls_30d: 5, errors_30d: 0, failures_30d: 0, failures_unsplit_30d: 0, refusals_30d: 0, avg_ms: 120, max_ms: 300, caller_days_30d: 2 }],
      daily_30d: [{ day: '2026-10-13', calls: 5, errors: 0, failures: 0, refusals: 0, caller_days: 2, self: 0, probe: 0 }],
      errors_by_kind_30d: [], errors_detail_30d: [], unknown_tools_30d: [],
      origins_30d: { external: 5, self: 0, probe: 0, self_since: null, refused_since: null },
      by_client_30d: [
        { client: 'Qwen Code', kind: 'представился', origin: 'external', region: 'КНР', calls: 5, caller_days: 2, last_seen: '2026-10-13 10:00' },
        { client: 'claude', kind: 'представился', origin: 'external', region: null, calls: 313, caller_days: 40, last_seen: '2026-10-13 09:00' },
      ],
      window_note: 'тест',
    });
    const { default: AdminMcpPage } = await import('@/app/hub/admin/mcp/page');
    render(React.createElement(AdminMcpPage));
    // Имя клиента стоит текстом рядом с вложенными подписями, поэтому ищем
    // строку клиента по её собственному span, а не по точному тексту узла.
    const qwen = await screen.findByText(/Qwen Code/, { selector: 'span.truncate' });
    const claude = screen.getByText(/^claude/, { selector: 'span.truncate' });
    expect(screen.getAllByText('КНР')).toHaveLength(1);
    expect(qwen.textContent).toContain('КНР');
    expect(claude.textContent).not.toContain('КНР');
  });
});
