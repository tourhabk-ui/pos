/**
 * «Анализатор безопасности» (/tools/safety): форма — три пути к ответу и
 * честные отказы (14.11).
 *
 * До 14.11 отказ поиска глушился пустым catch: подсказок нет — и человек
 * читал это как «ничего не найдено». Отказ геолокации говорил одну фразу на
 * все причины. Теперь поиск, который не ответил, называется словами, а
 * причина отказа геолокации — словами общего входа (lib/geo/current-position).
 *
 * Судится рендером экрана: ввод, нажатие, что ушло на сервер и что видит человек.
 */
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/tools/safety',
}));

const requestPosition = vi.fn();
vi.mock('@/lib/geo/current-position', async (orig) => ({
  ...(await orig<typeof import('@/lib/geo/current-position')>()),
  requestPosition: (...a: unknown[]) => requestPosition(...a),
}));

import { SafetyClient } from '@/app/tools/safety/_SafetyClient';
import { geoFailureText } from '@/lib/geo/current-position';

interface Sent { url: string; body: unknown }
const sent: Sent[] = [];
let searchFails = false;

const FAR = { kind: 'far', nearest: { id: 'a1', slug: 'vulkan-ksudach', name: 'Вулкан Ксудач', locationType: 'volcano', distanceKm: 43 } };

beforeEach(() => {
  sent.length = 0;
  searchFails = false;
  requestPosition.mockReset();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith('/api/places')) {
      if (searchFails) throw new Error('сеть');
      return new Response(JSON.stringify({ success: true, data: [{ id: 'place-0001-0001', name: 'Халактырский пляж', locationType: 'beach', description: '' }] }));
    }
    if (url.startsWith('/api/routes')) {
      return new Response(JSON.stringify({ success: true, data: [{ id: '22222222-2222-4222-8222-222222222222', title: 'Вулкан Горелый', activityType: 'hiking', difficulty: 'medium', distanceKm: 9 }] }));
    }
    return new Response(JSON.stringify({ success: true, data: FAR }));
  }) as unknown as typeof fetch;
});
afterEach(cleanup);

const analyzeCalls = () => sent.filter(s => s.url === '/api/tools/safety');

describe('GPS', () => {
  it('место определилось — на сервер ушли координаты, человек видит ответ', async () => {
    requestPosition.mockResolvedValue({ ok: true, lat: 53.02, lng: 158.65, accuracyM: 12 });
    render(<SafetyClient />);
    fireEvent.click(screen.getByTitle('Использовать моё местоположение'));
    await screen.findByRole('heading', { name: 'Что там, где вы стоите, мы не знаем' });
    expect(analyzeCalls().map(c => c.body)).toEqual([{ lat: 53.02, lng: 158.65 }]);
  });

  it.each(['denied', 'timeout', 'unavailable', 'unsupported'] as const)(
    'отказ «%s» — словами общего входа, запрос на сервер не уходит',
    async (kind) => {
      requestPosition.mockResolvedValue({ ok: false, kind });
      render(<SafetyClient />);
      fireEvent.click(screen.getByTitle('Использовать моё местоположение'));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(geoFailureText(kind));
      expect(analyzeCalls()).toHaveLength(0);
    },
  );
});

describe('поиск по названию', () => {
  it('место выбрано — на сервер ушёл его номер, человек видит ответ', async () => {
    render(<SafetyClient />);
    fireEvent.change(screen.getByPlaceholderText(/Авачинский вулкан/), { target: { value: 'Халак' } });
    fireEvent.click(await screen.findByText('Халактырский пляж'));
    fireEvent.click(screen.getByRole('button', { name: /Проверить безопасность/ }));
    await screen.findByRole('heading', { name: 'Что там, где вы стоите, мы не знаем' });
    expect(analyzeCalls().map(c => c.body)).toEqual([{ placeId: 'place-0001-0001' }]);
  });

  it('маршрут выбран — на сервер ушёл номер его карточки', async () => {
    render(<SafetyClient />);
    fireEvent.click(screen.getByRole('button', { name: /Маршрут/ }));
    fireEvent.change(screen.getByPlaceholderText(/Налычево/), { target: { value: 'Горел' } });
    fireEvent.click(await screen.findByText('Вулкан Горелый'));
    fireEvent.click(screen.getByRole('button', { name: /Проверить безопасность/ }));
    await waitFor(() => expect(analyzeCalls()).toHaveLength(1));
    expect(analyzeCalls()[0].body).toEqual({ routeId: '22222222-2222-4222-8222-222222222222' });
  });

  it('поиск не ответил — сказано словами, а не «ничего не найдено»', async () => {
    searchFails = true;
    render(<SafetyClient />);
    fireEvent.change(screen.getByPlaceholderText(/Авачинский вулкан/), { target: { value: 'Халак' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Поиск не ответил — попробуйте ещё раз');
  });

  it('пока ничего не выбрано — кнопка проверки не нажимается', () => {
    render(<SafetyClient />);
    expect((screen.getByRole('button', { name: /Проверить безопасность/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ответ сервера с отказом', () => {
  it('слова отказа видны человеку', async () => {
    requestPosition.mockResolvedValue({ ok: true, lat: 53.02, lng: 158.65, accuracyM: null });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      new Response(JSON.stringify({ success: false, error: 'Ближайшее место не прочиталось — попробуйте ещё раз' }), { status: 500 }));
    render(<SafetyClient />);
    fireEvent.click(screen.getByTitle('Использовать моё местоположение'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Ближайшее место не прочиталось — попробуйте ещё раз');
  });
});
