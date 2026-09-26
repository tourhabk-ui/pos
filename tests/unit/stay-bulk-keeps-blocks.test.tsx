/**
 * tests/unit/stay-bulk-keeps-blocks.test.tsx
 *
 * Массовая смена цены не открывает закрытые даты (аудит жилья 26.09).
 *
 * Было: в форме «Задать на диапазон» стоял флажок «Закрыть продажу», и
 * saveBulk ВСЕГДА слал isBlocked: bulkBlocked — по умолчанию false. Сервер
 * честно обновляет только переданные поля, но поле передавалось всегда:
 * владелец менял сезонную цену на месяц — и все даты, которые он раньше
 * закрыл (ремонт, свои гости), молча открывались для продажи.
 *
 * Стало: продажа — отдельный выбор «Не менять / Закрыть / Открыть», и
 * isBlocked уходит, только если владелец его сделал. Серверную половину
 * (непереданное поле не затирается) держит stay-bulk-rates.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

import StayCalendarClient from '@/app/hub/stay/calendar/_StayCalendarClient';

const ACC_ID = '33333333-3333-4333-8333-333333333333';

let posts: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  posts = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, message: 'Тариф применён к 3 дн.' }) });
    }
    if (url.startsWith('/api/stay/accommodations/') && url.endsWith('/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { rooms: [] } }) });
    }
    if (url.startsWith('/api/stay/accommodations')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { accommodations: [{ id: ACC_ID, name: 'Дом' }] } }) });
    }
    if (url.startsWith('/api/stay/calendar')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { basePrice: 5000, totalRooms: 3, rates: [], occupancy: [] } }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openBulk() {
  const utils = render(<StayCalendarClient />);
  await waitFor(() => expect(screen.getByText(/Задать на диапазон/)).toBeInTheDocument());
  fireEvent.click(screen.getByText(/Задать на диапазон/));
  const [start, end] = Array.from(utils.container.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
  fireEvent.change(start, { target: { value: '2099-08-01' } });
  fireEvent.change(end, { target: { value: '2099-08-03' } });
  return utils;
}

describe('массовое задание тарифа', () => {
  it('только цена → isBlocked НЕ уходит: закрытые даты остаются закрытыми', async () => {
    await openBulk();
    fireEvent.change(screen.getByPlaceholderText('Не менять'), { target: { value: '7000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe('/api/stay/calendar/bulk');
    expect(posts[0].body.priceOverride).toBe(7000);
    expect('isBlocked' in posts[0].body).toBe(false);
  });

  it('«Закрыть продажу» → isBlocked: true', async () => {
    await openBulk();
    fireEvent.change(screen.getByLabelText('Продажа'), { target: { value: 'close' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.isBlocked).toBe(true);
    expect('priceOverride' in posts[0].body).toBe(false);
  });

  it('«Открыть продажу» → isBlocked: false — открыть можно, но только явно', async () => {
    await openBulk();
    fireEvent.change(screen.getByLabelText('Продажа'), { target: { value: 'open' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.isBlocked).toBe(false);
  });

  it('ни цены, ни действия с продажей — применять нечего', async () => {
    await openBulk();
    expect(screen.getByRole('button', { name: 'Применить' })).toBeDisabled();
  });
});
