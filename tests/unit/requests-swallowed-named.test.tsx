// @vitest-environment jsdom
/**
 * Заявки и брони: проглоченный отказ назван, а не выдан за успех или ноль
 * (пустые catch, часть 2; слово владельца 16.11 «Just do it»).
 *
 *  - общий помощник логов не пишет почту и телефон человека целиком: SMTP
 *    повторяет адрес получателя в тексте ошибки;
 *  - туристу не ушло сообщение о подтверждении или отмене брони — в логе
 *    стоит область, канал и номер брони, а не тишина;
 *  - админка заявок: счёт по статусу не прочитался — на вкладке «?», а не 0
 *    и не «новых заявок нет».
 *
 * Судится вызовом и рендером.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const { poolQuery, sendMessage, sendBookingConfirmation, sendBookingCancellation } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  sendMessage: vi.fn(),
  sendBookingConfirmation: vi.fn(),
  sendBookingCancellation: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage } }));
vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendBookingConfirmation, sendBookingCancellation },
}));

import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { notifyBookingConfirmed, notifyBookingCancelled } from '@/lib/notifications/booking-notifications';
import { LeadsClient } from '@/app/hub/admin/leads/_LeadsClient';

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  poolQuery.mockReset();
  sendMessage.mockReset();
  sendBookingConfirmation.mockReset();
  sendBookingCancellation.mockReset();
});
afterEach(() => {
  errorSpy.mockRestore();
  cleanup();
  vi.unstubAllGlobals();
});

const logged = () => errorSpy.mock.calls.map((c) => JSON.stringify(c));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('помощник логов', () => {
  it('почта и телефон из текста ошибки в лог целиком не идут', () => {
    logSwallowedFailure('notify/booking', 'письмо', new Error('550 <ivan.petrov@example.org> rejected; tel +7 914 123-45-67'));
    const line = logged().join(' ');
    expect(line).toContain('[notify/booking] письмо не выполнен');
    expect(line).not.toContain('ivan.petrov@example.org');
    expect(line).not.toContain('123-45-67');
    expect(line).toContain('rejected');
  });
});

describe('сообщения туристу о брони', () => {
  const booking = { id: 'b-42', tourName: 'Вулкан Горелый', date: '2027-07-20', participants: 2, totalPrice: 15000 };

  it('Telegram и письмо о подтверждении не ушли — оба отказа названы с номером брони', async () => {
    poolQuery.mockResolvedValue({ rows: [{ name: 'Иван Петров', email: 'ivan@example.org', telegram_id: '777' }] });
    sendMessage.mockRejectedValue(new Error('Telegram API error: chat not found'));
    sendBookingConfirmation.mockRejectedValue(new Error('SMTP timeout'));
    await notifyBookingConfirmed('u-1', booking);
    await flush();
    const lines = logged().join('\n');
    expect(lines).toContain('Telegram о подтверждении брони b-42');
    expect(lines).toContain('письмо о подтверждении брони b-42');
  });

  it('отмена: отказ Telegram назван', async () => {
    poolQuery.mockResolvedValue({ rows: [{ name: 'Иван Петров', email: null, telegram_id: '777' }] });
    sendMessage.mockRejectedValue(new Error('Forbidden: bot was blocked by the user'));
    await notifyBookingCancelled('u-1', { ...booking, refundAmount: 0, refundPercent: 0 });
    await flush();
    expect(logged().join('\n')).toContain('Telegram об отмене брони b-42');
  });
});

describe('админка заявок: счёт по статусу', () => {
  it('счёт не прочитался — «?» на вкладке и строка «не загрузилось», а не ноль', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('limit=1')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ success: true, leads: [], total: 0, data: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }));
    const { container } = render(<LeadsClient />);
    await waitFor(() => expect(container.textContent).toContain('Сколько новых заявок — не загрузилось'));
    expect(screen.getAllByTitle('Счёт не загрузился').length).toBeGreaterThanOrEqual(5);
  });

  it('счёт прочитался — числа, без «?»', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const total = url.includes('status=new&limit=1') ? 3 : 0;
      return new Response(JSON.stringify({ success: true, leads: [], total, data: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }));
    const { container } = render(<LeadsClient />);
    await waitFor(() => expect(container.textContent).toContain('3 новых заявок'));
    expect(container.textContent).not.toContain('не загрузилось');
    expect(screen.queryAllByTitle('Счёт не загрузился')).toHaveLength(0);
  });
});
