// @vitest-environment jsdom
/**
 * Подпись частичного отказа в поиске (Ctrl+K) — рендером, не литералом (13.10).
 *
 * 04.11: после перевода findGeo на allSettled сервер штатно отвечает 200 с
 * `unavailable: ['tours','routes']` (туры и маршруты упали, места нашлись).
 * Подпись цепочкой тернариев называла только туры — турист принимал пустоту
 * маршрутов за «маршрутов нет». Сторож держит: названа КАЖДАЯ отказавшая
 * часть, ссылка на каталог — когда среди них туры, «Ничего не найдено» не
 * показывается рядом с отказом.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { GlobalSearchModal } from '@/components/search/GlobalSearchModal';

type Part = 'tours' | 'geo' | 'places' | 'routes';
const PLACE = { id: 'place-1', type: 'place', title: 'Авачинский вулкан', subtitle: 'Вулкан', href: '/places/avacha' };

function answer(unavailable: Part[], data: unknown[] = [PLACE]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, data, unavailable }),
  }));
}

async function search(q: string) {
  render(<GlobalSearchModal />);
  act(() => { window.dispatchEvent(new Event('open-search')); });
  const input = await screen.findByLabelText('Что ищем');
  fireEvent.change(input, { target: { value: q } });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('поиск: подпись частичного отказа называет каждую часть', () => {
  const CASES: Array<{ parts: Part[]; text: string; catalog: boolean }> = [
    { parts: ['tours'], text: 'Туры сейчас не ищутся — это сбой, а не пустой результат.', catalog: true },
    { parts: ['geo'], text: 'Места и маршруты сейчас не ищутся — это сбой, а не пустой результат.', catalog: false },
    { parts: ['routes'], text: 'Маршруты сейчас не ищутся — это сбой, а не пустой результат.', catalog: false },
    { parts: ['places'], text: 'Места сейчас не ищутся — это сбой, а не пустой результат.', catalog: false },
    { parts: ['tours', 'routes'], text: 'Туры и маршруты сейчас не ищутся — это сбой, а не пустой результат.', catalog: true },
    { parts: ['tours', 'places'], text: 'Туры и места сейчас не ищутся — это сбой, а не пустой результат.', catalog: true },
  ];

  for (const c of CASES) {
    it(`unavailable ${JSON.stringify(c.parts)}`, async () => {
      answer(c.parts);
      await search('авач');
      expect(await screen.findByText(c.text)).toBeTruthy();
      // Найденное показывается рядом с подписью, а не вместо неё.
      expect(screen.getByText('Авачинский вулкан')).toBeTruthy();
      const catalog = screen.queryByRole('link', { name: 'Каталог туров' });
      if (c.catalog) expect(catalog?.getAttribute('href')).toBe('/catalog');
      else expect(catalog).toBeNull();
    });
  }

  it('пусто при отказе части — «Ничего не найдено» не говорится', async () => {
    answer(['routes'], []);
    await search('авач');
    expect(await screen.findByText('Маршруты сейчас не ищутся — это сбой, а не пустой результат.')).toBeTruthy();
    expect(screen.queryByText(/Ничего не найдено/)).toBeNull();
  });

  it('пусто без отказа — «Ничего не найдено», подписи отказа нет', async () => {
    answer([], []);
    await search('авач');
    await waitFor(() => expect(screen.getByText(/Ничего не найдено/)).toBeTruthy());
    expect(screen.queryByText(/сейчас не ищутся/)).toBeNull();
  });
});
