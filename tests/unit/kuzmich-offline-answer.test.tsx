/**
 * Кузьмич без сети отвечает памятками Спасателя, а не молчит (карт-бланш
 * владельца 27.11). Правило — вызовом lib/kuzmich/offline-answer, экраны —
 * рендером: страница /kuzmich и /ai-assistant. Плавающий виджет
 * (components/kuzmich/KuzmichWidget) сейчас не рисуется ни на одной странице —
 * его HIDDEN_PATHS содержит '/' при проверке startsWith, — поэтому не тронут.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  OFFLINE_NO_ANSWER, OFFLINE_PROTOCOL_LEAD, OfflineError,
  isOfflineFailure, offlineKuzmichAnswer,
} from '@/lib/kuzmich/offline-answer';
import { ITEM_LOSS_PROTOCOL, LOCAL_PROTOCOLS } from '@/lib/safety/rescue-protocols';

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <img alt={p.alt} /> }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  usePathname: () => '/catalog',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }) }));

import KuzmichClient from '@/app/kuzmich/_KuzmichClient';
import AIAssistantPage from '@/app/ai-assistant/_AIAssistantClient';

const BEAR = LOCAL_PROTOCOLS[0][1];
const LOST = LOCAL_PROTOCOLS[1][1];

describe('правило ответа без сети', () => {
  it('памятка Спасателя — та же, что в Спасателе, и с пометкой, откуда ответ', () => {
    expect(offlineKuzmichAnswer('рядом медведь')).toBe(`${OFFLINE_PROTOCOL_LEAD}\n\n${BEAR}`);
  });

  it('история разговора учитывается: «Потеряли рюкзак» после «Мы заблудились» — не утеря вещи', () => {
    expect(offlineKuzmichAnswer('Потеряли рюкзак', ['Мы заблудились'])).toBe(`${OFFLINE_PROTOCOL_LEAD}\n\n${LOST}`);
    expect(offlineKuzmichAnswer('украли кошелек в автобусе')).toBe(`${OFFLINE_PROTOCOL_LEAD}\n\n${ITEM_LOSS_PROTOCOL}`);
  });

  it('беда без памятки — 112 и кнопка SOS, без выдуманных шагов', () => {
    const t = offlineKuzmichAnswer('SOS');
    expect(t).toBe(OFFLINE_NO_ANSWER);
    expect(t).toMatch(/112/);
    expect(t).toMatch(/кнопка SOS в шапке работает и без сети/);
    expect(t).not.toContain(OFFLINE_PROTOCOL_LEAD);
  });

  it('обычный вопрос — честно: ответа без сети нет, 112 и SOS названы', () => {
    expect(offlineKuzmichAnswer('Какая завтра погода на Мутновском?')).toBe(OFFLINE_NO_ANSWER);
    expect(OFFLINE_NO_ANSWER).toMatch(/112/);
    expect(OFFLINE_NO_ANSWER).toMatch(/SOS/);
  });

  it('сетевой отказ отличается от отказа сервера', () => {
    expect(isOfflineFailure(new OfflineError())).toBe(true);
    expect(isOfflineFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isOfflineFailure(new Error('HTTP 500'))).toBe(false);
  });
});

describe('экраны Кузьмича без сети', () => {
  let posts: string[] = [];
  let online = false;
  beforeEach(() => {
    posts = [];
    online = false;
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/api/ai/chat')) {
        posts.push(String(url));
        return online
          ? Promise.resolve(new Response(JSON.stringify({ data: { answer: 'Ответ сервера.' } })))
          : Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: { messages: [] } })));
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const ask = (box: HTMLElement, text: string) => {
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
  };

  it('/kuzmich: запрос не уходит, ответ — памятка про медведя', async () => {
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Опишите мечту/);
    ask(box, 'рядом медведь');
    expect(await screen.findByText(/Связи нет — отвечаю памяткой/)).toBeTruthy();
    expect(screen.getByText(/Не беги/)).toBeTruthy();
    expect(posts).toEqual([]);
    expect(screen.queryByText('Нет связи. Попробуйте позже.')).toBeNull();
  });

  it('/kuzmich: история разговора доходит до памятки — «потеряли рюкзак» после «мы заблудились» не утеря вещи', async () => {
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Опишите мечту/);
    ask(box, 'мы заблудились');
    await screen.findByText(/Оставайся на месте/);
    ask(box, 'Потеряли рюкзак');
    await waitFor(() => expect(screen.getAllByText(/Оставайся на месте/).length).toBe(2));
    // Протокол утери вещей называет полицию 102 — здесь его быть не должно.
    expect(screen.queryByText(/102/)).toBeNull();
    expect(posts).toEqual([]);
  });

  it('/kuzmich: запрос ушёл и упал на сети — тоже памятка, а не «попробуйте позже»', async () => {
    online = true;
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Опишите мечту/);
    online = false;
    // Браузер ещё считает, что сеть есть, — отказ приходит из fetch.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(String(url)); return Promise.reject(new TypeError('Failed to fetch')); }
      return Promise.resolve(new Response(JSON.stringify({ data: { messages: [] } })));
    }));
    ask(box, 'мы заблудились');
    expect(await screen.findByText(/Связи нет — отвечаю памяткой/)).toBeTruthy();
    expect(screen.getByText(/Оставайся на месте/)).toBeTruthy();
    expect(posts.length).toBe(1);
  });

  it('/kuzmich: с сетью — ответ сервера, памятки нет', async () => {
    online = true;
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Опишите мечту/);
    ask(box, 'рядом медведь');
    expect(await screen.findByText('Ответ сервера.')).toBeTruthy();
    expect(screen.queryByText(/отвечаю памяткой/)).toBeNull();
  });

  it('/ai-assistant: без сети поле не заблокировано, ответ — памятка или честное «нет ответа»', async () => {
    render(<AIAssistantPage />);
    const box = await screen.findByPlaceholderText('Спросите Кузьмича...');
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText(/Кузьмич отвечает памятками по безопасности, записанными заранее/)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Какая завтра погода?' } });
    fireEvent.submit(box.closest('form')!);
    expect(await screen.findByText(OFFLINE_NO_ANSWER)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'холодно, замёрзли' } });
    fireEvent.submit(box.closest('form')!);
    expect(await screen.findByText(/Снять мокрое/)).toBeTruthy();
    expect(posts).toEqual([]);
  });
});
