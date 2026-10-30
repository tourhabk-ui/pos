/**
 * Экран «Входящих»: куда ведёт ответ на предмет — рендером с данными сервера
 * (CLAUDE.md §4, решение 13.10).
 *
 * Бронь тура продают и оператор, и гид со своими турами (28.10, миграция
 * 1338). Ссылка ответа берётся по роли из ответа сервера (`data.category`):
 * гиду — раздел «Свои туры», оператору — «Бронирования». До 29.10 ссылка
 * считалась по одному виду предмета, и бронь в кабинете гида вела бы в
 * кабинет оператора, куда гида не пускают.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import React from 'react';

import { InboxScreen } from '@/components/crm/InboxScreen';
import { CRM_INBOX_API } from '@/components/crm/api';

const item = (kind: string, id: string, title: string) => ({
  kind, id, title, created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  date: '2030-07-01', people: 2, contact_id: null, contact_name: null, waiting_minutes: 180,
});

function serve(category: string, items: unknown[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== CRM_INBOX_API) throw new Error(`неожиданный адрес ${url}`);
    return {
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: {
          category, items, failed: [],
          response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
          chat: { state: 'none' }, not_here: [],
        },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ссылка ответа во «Входящих» — по роли', () => {
  it('гид: бронь своего тура — «Свои туры»; запрос мест — кнопки здесь же, без ссылки', async () => {
    serve('guide', [item('operator_booking', '501', 'Авторский тур'), item('seat_request', 'aaaaaaaa-0000-4000-8000-0000000000aa', 'Авторский тур')]);
    render(<InboxScreen />);

    const booking = (await screen.findByText('Бронь тура')).closest('li') as HTMLElement;
    const link = within(booking).getByRole('link');
    expect(link.getAttribute('href')).toBe('/hub/guide/own');
    expect(link.textContent).toMatch(/в разделе «Свои туры»/);

    const seat = screen.getByText('Запрос мест').closest('li') as HTMLElement;
    expect(within(seat).queryByRole('link')).toBeNull();
    expect(within(seat).getByRole('button', { name: 'Есть места' })).toBeTruthy();
    // Ни одна ссылка экрана гида не ведёт в кабинет оператора.
    for (const a of screen.getAllByRole('link')) expect(a.getAttribute('href')).not.toMatch(/^\/hub\/operator/);
  });

  it('оператор: та же бронь — «Бронирования» его кабинета', async () => {
    serve('operator', [item('operator_booking', '502', 'Тур оператора')]);
    render(<InboxScreen />);

    const booking = (await screen.findByText('Бронь тура')).closest('li') as HTMLElement;
    expect(within(booking).getByRole('link').getAttribute('href')).toBe('/hub/operator/bookings');
  });
});
