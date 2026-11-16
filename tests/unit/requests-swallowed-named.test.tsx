// @vitest-environment jsdom
/**
 * Заявки и брони: проглоченный отказ назван, а не выдан за успех или ноль
 * (пустые catch, часть 2; слово владельца 16.11 «Just do it»).
 *
 *  - общий помощник логов не пишет почту и телефон человека целиком: SMTP
 *    повторяет адрес получателя в тексте ошибки;
 *  - туристу не ушло сообщение о подтверждении или отмене брони — в логе
 *    стоит область, канал и номер брони, а не тишина. Отказ подкладывается
 *    в настоящей форме: Telegram и почта не бросают, а отвечают
 *    `{ success: false }`;
 *  - админка заявок: счёт по статусу не прочитался — на вкладке «?», а не 0
 *    и не «новых заявок нет».
 *
 * Судится вызовом и рендером.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const { poolQuery, dbQuery, sendMessage, sendBookingConfirmation, sendBookingCancellation } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  dbQuery: vi.fn(),
  sendMessage: vi.fn(),
  sendBookingConfirmation: vi.fn(),
  sendBookingCancellation: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/database', () => ({ query: dbQuery }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage } }));
vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendBookingConfirmation, sendBookingCancellation },
}));

import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { notifyBookingConfirmed, notifyBookingCancelled } from '@/lib/notifications/booking-notifications';
import { notifyTouristBookingCreated, notifyTouristDocumentExpiring } from '@/lib/telegram/booking-notify';
import { LeadsClient } from '@/app/hub/admin/leads/_LeadsClient';

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  poolQuery.mockReset();
  dbQuery.mockReset();
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

  // Настоящая форма отказа: Telegram и почта не бросают, а отвечают
  // { success: false, error } — `.catch` её не видит.
  it('Telegram и письмо о подтверждении не ушли — оба отказа названы с номером брони', async () => {
    poolQuery.mockResolvedValue({ rows: [{ name: 'Иван Петров', email: 'ivan@example.org', telegram_id: '777' }] });
    sendMessage.mockResolvedValue({ success: false, error: 'Bad Request: chat not found' });
    sendBookingConfirmation.mockResolvedValue({ success: false, error: 'SMTP timeout' });
    await notifyBookingConfirmed('u-1', booking);
    await flush();
    const lines = logged().join('\n');
    expect(lines).toContain('Telegram о подтверждении брони b-42');
    expect(lines).toContain('chat not found');
    expect(lines).toContain('письмо о подтверждении брони b-42');
  });

  it('отмена: отказ Telegram назван, и исключением тоже', async () => {
    poolQuery.mockResolvedValue({ rows: [{ name: 'Иван Петров', email: null, telegram_id: '777' }] });
    sendMessage.mockResolvedValue({ success: false, error: 'Forbidden: bot was blocked by the user' });
    await notifyBookingCancelled('u-1', { ...booking, refundAmount: 0, refundPercent: 0 });
    await flush();
    expect(logged().join('\n')).toContain('Telegram об отмене брони b-42');

    errorSpy.mockClear();
    sendMessage.mockRejectedValue(new Error('socket hang up'));
    await notifyBookingCancelled('u-1', { ...booking, refundAmount: 0, refundPercent: 0 });
    await flush();
    expect(logged().join('\n')).toContain('Telegram об отмене брони b-42');
  });

  it('ушло — в логе пусто', async () => {
    poolQuery.mockResolvedValue({ rows: [{ name: 'Иван Петров', email: 'ivan@example.org', telegram_id: '777' }] });
    sendMessage.mockResolvedValue({ success: true, messageId: 1 });
    sendBookingConfirmation.mockResolvedValue({ success: true });
    await notifyBookingConfirmed('u-1', booking);
    await flush();
    expect(logged()).toEqual([]);
  });

  it('Telegram туристу о новой заявке не ушёл — назван с номером брони', async () => {
    dbQuery.mockResolvedValue({ rows: [{ telegram_id: '777' }] });
    sendMessage.mockResolvedValue({ success: false, error: 'Forbidden: bot was blocked by the user' });
    notifyTouristBookingCreated('u-1', { id: 'b-43', tourTitle: 'Вулкан Горелый', date: new Date('2027-07-20T00:00:00Z'), participants: 2, totalAmount: 15000 });
    for (let i = 0; i < 5; i++) await flush();
    expect(logged().join('\n')).toContain('сообщение туристу о новой заявке b-43');
  });

  it('чтение контактов туриста упало — названо, а не «контактов нет» (ревью #3464)', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    await notifyBookingConfirmed('u-1', booking);
    await flush();
    expect(logged().join('\n')).toContain('чтение контактов туриста');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('напоминание о сроке документа не ушло (success: false) — названо (ревью #3464)', async () => {
    dbQuery.mockResolvedValue({ rows: [{ telegram_id: '777' }] });
    sendMessage.mockResolvedValue({ success: false, error: 'Forbidden: bot was blocked by the user' });
    notifyTouristDocumentExpiring('u-1', { documentType: 'passport', expiryDate: '2027-01-10', daysLeft: 20 });
    for (let i = 0; i < 5; i++) await flush();
    expect(logged().join('\n')).toContain('напоминание туристу о сроке документа');
  });

  it('чтение Telegram туриста упало — названо, а не «не привязан»', async () => {
    dbQuery.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    notifyTouristBookingCreated('u-1', { id: 'b-44', tourTitle: 'Вулкан Горелый', date: new Date('2027-07-20T00:00:00Z'), participants: 2, totalAmount: 15000 });
    for (let i = 0; i < 5; i++) await flush();
    expect(logged().join('\n')).toContain('чтение Telegram туриста');
    expect(sendMessage).not.toHaveBeenCalled();
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
