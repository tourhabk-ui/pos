/**
 * Чат Кузьмича /ai-assistant читается на телефоне (владелец 28.11: «ни хрена
 * не видно, всё сливается» и «подвал у кузьмича убери — это же чат, в чатах
 * подвалов нет»).
 *
 * До правки ответ рисовался сырым текстом: длинный адрес тура не переносился,
 * растягивал пузырь за экран, и под чатом стоял подвал сайта. Теперь ответ —
 * тем же ChatText, что на /kuzmich (ссылки кликабельны и переносятся), пузырь
 * переносит длинное слово, а подвала у /ai-assistant нет.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { showSiteFooter } from '@/lib/navigation/site-footer-paths';

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span role="img" aria-label={p.alt} /> }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  usePathname: () => '/ai-assistant',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }) }));

import AIAssistantPage from '@/app/ai-assistant/_AIAssistantClient';

const URL_LONG = 'https://vedarai.ru/catalog/tours/zimnyaya-rybalka-noyabr-yanvar';
const ANSWER = `Туры на зиму:\n- Зимняя рыбалка — Камчатская рыбалка — 22 000 ₽ за чел./день — ${URL_LONG}`;
const ASK = 'Что есть на зиму?';

describe('/ai-assistant на телефоне', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/api/ai/chat')) {
        return Promise.resolve(new Response(JSON.stringify({ data: { answer: ANSWER } })));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: { messages: [] } })));
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('длинный адрес в ответе — кликабельная ссылка, которая переносится, а пузырь не растягивается', async () => {
    render(<AIAssistantPage />);
    const box = await screen.findByPlaceholderText('Спросите Кузьмича...');
    fireEvent.change(box, { target: { value: ASK } });
    fireEvent.submit(box.closest('form')!);

    const link = await screen.findByRole('link', { name: URL_LONG });
    expect(link.getAttribute('href')).toBe('/catalog/tours/zimnyaya-rybalka-noyabr-yanvar');
    expect(link.className).toMatch(/break-all/);
    // Пункт «- …» — списком, как на /kuzmich.
    expect(link.closest('li')).not.toBeNull();
    const bubble = link.closest('[class*="overflow-wrap:anywhere"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.className).toMatch(/min-w-0/);
  });

  it('вопрос человека — текстом, без ссылок', async () => {
    render(<AIAssistantPage />);
    const box = await screen.findByPlaceholderText('Спросите Кузьмича...');
    fireEvent.change(box, { target: { value: `Вот адрес ${URL_LONG}` } });
    fireEvent.submit(box.closest('form')!);
    await screen.findByRole('link', { name: URL_LONG });
    expect(screen.getAllByRole('link', { name: URL_LONG })).toHaveLength(1);
  });

  it('подвала сайта у чата нет — ни у /ai-assistant, ни у /kuzmich', () => {
    expect(showSiteFooter('/ai-assistant')).toBe(false);
    expect(showSiteFooter('/kuzmich')).toBe(false);
    expect(showSiteFooter('/o-kuzmiche')).toBe(true);
  });
});
