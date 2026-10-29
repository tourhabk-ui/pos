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
 *
 * Пул базы не подменён: страница базу не читает и не импортирует — числа
 * лимитов берёт из write-limits. Импорт базы ловит сторож no-build-time-db,
 * а не этот рендер (пул создаётся лениво).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import McpLandingPage from '@/app/mcp/page';
import { MCP_CONNECT_OPTIONS, MCP_TRANSPORT_SPELLINGS, MCP_ENDPOINT } from '@/lib/mcp/connect';
import { MCP_READ_PER_MINUTE } from '@/lib/mcp/public-tools';
import { CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_DAY, CLIENT_WINDOW_MINUTES } from '@/lib/mcp/write-limits';
import { NOTIFY_TOOL_NAMES, NOTIFY_HOW_TO_VERIFY } from '@/lib/mcp/request-notify-schema';

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
  it('записей пять, подтверждает человек; лимиты — числа сервера; мост mcp-remote назван', () => {
    const { container } = page();
    const text = container.textContent ?? '';
    expect(text).toContain('Записей пять');
    expect(text).not.toMatch(/записи две/);
    expect(text).toContain('подтверждает её человек');
    expect(text).toContain(`чтение — ${MCP_READ_PER_MINUTE} вызовов в минуту`);
    expect(text).toContain(`заявки — ${CLIENT_MAX_PER_WINDOW} за ${CLIENT_WINDOW_MINUTES} минут и ${CLIENT_MAX_PER_DAY} в сутки`);
    expect(text).toContain(`npx -y mcp-remote ${MCP_ENDPOINT} --transport http-only`);
  });
});

describe('/mcp: уведомления об изменении заявки (29.10)', () => {
  it('раздел виден: поле, инструменты, как проверить подпись и защититься от повтора, 410, жильё без уведомлений', () => {
    const { container } = page();
    const section = container.querySelector('#notify');
    expect(section).not.toBeNull();
    const text = section!.textContent ?? '';
    expect(text).toContain('notify_url');
    for (const n of NOTIFY_TOOL_NAMES) expect(text).toContain(n);
    expect(text).toContain(NOTIFY_HOW_TO_VERIFY);
    expect(text).toMatch(/старше 5 минут/);
    expect(text).toMatch(/410/);
    expect(text).toMatch(/У заявки на жильё уведомлений нет/);
    expect(text).not.toMatch(/create_stay_request/);
  });
});
