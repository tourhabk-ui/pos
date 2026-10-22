/**
 * #2527, восьмой круг ревью: AI Спасатель судит утерю вещи по всему чату.
 *
 * Локальный протокол отвечает раньше сети (RescueChat на /sos и /safety), а
 * в хабе — без сети и при отказе ИИ. Короткая реплика «Потеряли рюкзак» сама
 * по себе — фраза шаблона утери вещи. Но если прошлой репликой человек
 * написал «Мы заблудились», это не кража в городе, и «заблокируйте карту,
 * 102» ему не к месту. Поэтому экран передаёт протоколу прежние реплики
 * человека.
 *
 * Сторож — рендер обоих экранов: человек пишет две реплики и видит ответы.
 * Передай экран протоколу одну текущую реплику — и второй ответ станет
 * протоколом вещей, сторож покраснеет.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import RescueChat from '@/components/safety/RescueChat';
import SafetyHubClient from '@/app/hub/safety/_SafetyHubClient';

const LOST_STEP = /3 свистка подряд/;
const ITEM_STEP = /талон-уведомление/;
const BLOCK_CARD = /заблокируйте карту/;

// В jsdom нет прокрутки, а оба чата прокручивают ленту к последнему ответу.
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalScrollTo = Element.prototype.scrollTo;
beforeAll(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() { /* jsdom: прокрутки нет */ };
  Element.prototype.scrollTo = function scrollTo() { /* jsdom: прокрутки нет */ } as typeof Element.prototype.scrollTo;
});
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  Element.prototype.scrollTo = originalScrollTo;
});
afterEach(cleanup);

describe('RescueChat (/sos, /safety): прошлая реплика человека', () => {
  const open = () => {
    render(<RescueChat surface="sos" />);
    fireEvent.click(screen.getByRole('button', { name: /AI Спасатель/ }));
  };
  const ask = (text: string) => {
    fireEvent.change(screen.getByLabelText('Опишите ситуацию'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  };

  it('«Мы заблудились», затем «Потеряли рюкзак» — оба раза «заблудился», протокола кражи нет', () => {
    open();
    ask('Мы заблудились');
    ask('Потеряли рюкзак');
    expect(screen.getAllByText(LOST_STEP)).toHaveLength(2);
    expect(screen.queryByText(BLOCK_CARD)).toBeNull();
  });

  it('та же «Потеряли рюкзак» первой репликой — протокол вещей: история отнимает его, а не слово', () => {
    open();
    ask('Потеряли рюкзак');
    expect(screen.getByText(ITEM_STEP)).toBeTruthy();
  });

  it('утеря вслед за утерей — протокол вещей оба раза', () => {
    open();
    ask('Украли кошелек в автобусе');
    ask('Паспорт украли');
    expect(screen.getAllByText(ITEM_STEP)).toHaveLength(2);
    expect(screen.queryByText(LOST_STEP)).toBeNull();
  });

  it('«Я потерял паспорт» — фраза из issue — протокол вещей, не «заблудился»', () => {
    open();
    ask('Я потерял паспорт');
    expect(screen.getByText(ITEM_STEP)).toBeTruthy();
    expect(screen.queryByText(LOST_STEP)).toBeNull();
  });

  it('«Мы заблудились», затем «Мы потеряли рюкзак» — оба раза «заблудился»: подлежащее историю не обходит', () => {
    open();
    ask('Мы заблудились');
    ask('Мы потеряли рюкзак');
    expect(screen.getAllByText(LOST_STEP)).toHaveLength(2);
    expect(screen.queryByText(BLOCK_CARD)).toBeNull();
  });
});

describe('Хаб безопасности (/hub/safety) без сети: прошлая реплика человека', () => {
  const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
  // Сети нет: ответ — только локальный протокол, запрос к ИИ не уходит.
  const fetchSpy = vi.fn(() => Promise.reject(new Error('нет сети')));
  beforeAll(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterAll(() => {
    if (descriptor) Object.defineProperty(window.navigator, 'onLine', descriptor);
    else Reflect.deleteProperty(window.navigator, 'onLine');
    vi.unstubAllGlobals();
  });

  const ask = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Опишите ситуацию...'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  };

  it('«Мы заблудились», затем «Потеряли рюкзак» — оба раза «заблудился», протокола кражи нет', () => {
    render(<SafetyHubClient />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Спасатель' }));
    ask('Мы заблудились');
    ask('Потеряли рюкзак');
    expect(screen.getAllByText(LOST_STEP)).toHaveLength(2);
    expect(screen.queryByText(BLOCK_CARD)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalledWith('/api/safety/rescue-chat', expect.anything());
  });

  it('«Потеряли рюкзак» первой репликой — протокол вещей', () => {
    render(<SafetyHubClient />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Спасатель' }));
    ask('Потеряли рюкзак');
    expect(screen.getByText(ITEM_STEP)).toBeTruthy();
  });
});

describe('Хаб безопасности: ИИ не ответил — локальный протокол с той же историей', () => {
  const ask = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Опишите ситуацию...'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  const dialog = async () => {
    render(<SafetyHubClient />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Спасатель' }));
    ask('Мы заблудились');
    await waitFor(() => expect(screen.getAllByText(LOST_STEP)).toHaveLength(1));
    ask('Потеряли рюкзак');
    await waitFor(() => expect(screen.getAllByText(LOST_STEP)).toHaveLength(2));
    expect(screen.queryByText(BLOCK_CARD)).toBeNull();
  };

  it('сеть оборвалась (таймаут, отказ) — «Потеряли рюкзак» после «Мы заблудились» не протокол кражи', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('таймаут'))));
    await dialog();
  });

  it('ИИ ответил отказом — «Потеряли рюкзак» после «Мы заблудились» не протокол кражи', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'ИИ недоступен' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }))));
    await dialog();
  });
});
