/**
 * /mcp — рендер того, что видит человек, подключающий Ведар к своему
 * ассистенту (план ИИ-каналов, владелец 16.10: «хорошо»).
 *
 * Сверка клиентов 16.10 показала, что инструкции расходились с клиентами:
 * у каждого своё написание Streamable HTTP, и чужое уводит в старый SSE, а
 * наш сервер на GET-поток отвечает 405. Страница обязана показать способ под
 * каждый клиент, оговорку там, где способ не проверен, таблицу написаний и
 * правду о записях: их четыре, каждую подтверждает человек, лимиты — те же
 * числа, что у сервера (CLAUDE.md §4: сторож судит рендер, не исходник).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

import McpLandingPage from '@/app/mcp/page';
import { MCP_CONNECT_OPTIONS, MCP_TRANSPORT_SPELLINGS, MCP_ENDPOINT } from '@/lib/mcp/connect';
import { MCP_READ_PER_MINUTE } from '@/lib/mcp/public-tools';
import { CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_DAY, CLIENT_WINDOW_MINUTES } from '@/lib/mcp/write-guard';

function page() {
  return render(McpLandingPage());
}

describe('/mcp: способ подключения под каждый клиент', () => {
  it('каждый вариант виден: ссылки — кнопками, остальные — карточкой с текстом способа', () => {
    const { container } = page();
    for (const o of MCP_CONNECT_OPTIONS) {
      const el = container.querySelector(`[data-connect="${o.id}"]`);
      expect(el, o.id).not.toBeNull();
      if (o.kind === 'link') {
        expect(el!.getAttribute('href'), o.id).toBe(o.value);
        expect(el!.textContent).toBe(o.label);
      } else {
        expect(el!.textContent, o.id).toContain(o.label);
        expect(el!.querySelector('pre')!.textContent, o.id).toBe(o.value);
      }
    }
  });

  it('оговорка о непроверенном видна у каждого варианта, где она есть, и только у них', () => {
    const { container } = page();
    const withNote = MCP_CONNECT_OPTIONS.filter((o) => o.note);
    expect(withNote.length).toBeGreaterThan(0);
    for (const o of withNote) {
      const note = container.querySelector(`[data-connect-note="${o.id}"]`);
      expect(note, o.id).not.toBeNull();
      expect(note!.textContent, o.id).toContain(o.note!);
    }
    expect(container.querySelectorAll('[data-connect-note]').length).toBe(withNote.length);
  });

  it('чаты называны по-человечески: Claude, ChatGPT, Mistral', () => {
    page();
    expect(screen.getByText('Claude.ai, Claude Desktop и мобильный Claude')).toBeTruthy();
    expect(screen.getByText('ChatGPT (веб)')).toBeTruthy();
    expect(screen.getByText('Mistral Le Chat (теперь Vibe)')).toBeTruthy();
  });
});

describe('/mcp: таблица написаний транспорта', () => {
  it('строка на каждое написание; непроверенные помечены', () => {
    const { container } = page();
    const table = container.querySelector('[data-transport-table]') as HTMLElement;
    expect(table).not.toBeNull();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBe(MCP_TRANSPORT_SPELLINGS.length);
    MCP_TRANSPORT_SPELLINGS.forEach((t, i) => {
      expect(rows[i].textContent).toContain(t.clients);
      expect(rows[i].textContent).toContain(t.spelling);
      expect(/не документирован/.test(rows[i].textContent ?? ''), t.clients).toBe(Boolean(t.unverified));
    });
  });
});

describe('/mcp: правда о записях и лимитах', () => {
  it('записей четыре, подтверждает человек; лимиты — числа сервера; мост mcp-remote назван', () => {
    const { container } = page();
    const text = container.textContent ?? '';
    expect(text).toContain('Записей четыре');
    expect(text).not.toMatch(/записи две/);
    expect(text).toContain('подтверждает её человек');
    expect(text).toContain(`чтение — ${MCP_READ_PER_MINUTE} вызовов в минуту`);
    expect(text).toContain(`заявки — ${CLIENT_MAX_PER_WINDOW} за ${CLIENT_WINDOW_MINUTES} минут и ${CLIENT_MAX_PER_DAY} в сутки`);
    expect(text).toContain(`npx -y mcp-remote ${MCP_ENDPOINT} --transport http-only`);
  });
});
