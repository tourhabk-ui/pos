/**
 * Экран задач: чем кончилось напоминание о сроке — рендером с данными
 * сервера (CLAUDE.md §4, решение 13.10).
 *
 * Исход `team` (CRM 2г, миграция 1231): у кабинета канала нет, но напоминание
 * дошло до менеджеров команды. Показать его прежним «не отправлено» было бы
 * неправдой — подпись своя, тон спокойный, с моментом отправки. «Слать
 * некуда» остаётся предупреждением.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

import { TaskList } from '@/components/crm/TaskList';

const due = new Date(Date.now() - 30 * 60_000).toISOString();
const task = (id: string, title: string, channel: string) => ({
  id, title, details: null, due_at: due, done_at: null, contact: null,
  created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  reminder: { at: new Date(Date.now() - 10 * 60_000).toISOString(), channel },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('подпись исхода напоминания на экране задач', () => {
  it('team — «ушло менеджерам», без тона предупреждения; unreachable — «не отправлено»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { items: [task('t1', 'Позвонить группе', 'team'), task('t2', 'Уточнить состав', 'unreachable')] } }),
    })));
    render(<TaskList />);

    const team = await screen.findByText(/напоминание ушло менеджерам: у кабинета не подключён ни MAX, ни Telegram/);
    expect(team.className).not.toMatch(/--warning/);
    expect(team.textContent).toMatch(/ · /); // момент отправки показан

    const none = screen.getByText(/напоминание не отправлено: не подключён ни MAX, ни Telegram/);
    expect(none.className).toMatch(/--warning/);
  });
});
