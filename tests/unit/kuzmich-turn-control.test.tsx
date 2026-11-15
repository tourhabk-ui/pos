/**
 * «Остановить» и «Ещё раз» в веб-чате Кузьмича (#3412, п. 3; слово владельца
 * 15.11 «карт-бланш»). Правила — вызовом lib/kuzmich/turn-control, кнопки —
 * рендером страницы /kuzmich.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { canStopTurn, retryQuestion, TURN_STOPPED_TEXT, isAbortError } from '@/lib/kuzmich/turn-control';

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <img alt={p.alt} /> }));

import KuzmichClient from '@/app/kuzmich/_KuzmichClient';

describe('правила', () => {
  it('ответ на «да» не останавливается (заявка уже уходит); остальное — да', () => {
    expect(canStopTurn('да')).toBe(false);
    expect(canStopTurn('Да, всё верно')).toBe(false);
    expect(canStopTurn('Когда идёт нерка?')).toBe(true);
    expect(canStopTurn('нет')).toBe(true);
  });

  it('«Ещё раз» — последний вопрос; не для «да»/«нет», фото и формы заявки', () => {
    const a = (content: string, extra = {}) => ({ role: 'assistant' as const, content, ...extra });
    const u = (content: string, extra = {}) => ({ role: 'user' as const, content, ...extra });
    expect(retryQuestion([u('Погода на Авачинском?'), a('Ветер 12 м/с.')])).toBe('Погода на Авачинском?');
    expect(retryQuestion([u('Погода?'), a(TURN_STOPPED_TEXT)])).toBe('Погода?');
    expect(retryQuestion([u('да'), a('Заявка создана.')])).toBeNull();
    expect(retryQuestion([u('нет'), a('Не отправляю.')])).toBeNull();
    expect(retryQuestion([u('(фото)', { imagePreview: 'data:x' }), a('Это Корякский.')])).toBeNull();
    expect(retryQuestion([u('Хочу тур'), a('Заполните форму.', { bookingForm: {} })])).toBeNull();
    expect(retryQuestion([u('Погода?')])).toBeNull();
    expect(retryQuestion([])).toBeNull();
  });

  it('обрыв по кнопке отличается от сбоя сети', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('страница /kuzmich', () => {
  let posts: Array<{ message: string }> = [];
  let hang = true;
  beforeEach(() => {
    posts = [];
    hang = true;
    // jsdom не умеет прокрутку; страница прокручивает к последнему сообщению.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return Promise.resolve(new Response(JSON.stringify({ data: { messages: [] } })));
      posts.push(JSON.parse(String(init.body)));
      if (!hang) return Promise.resolve(new Response(JSON.stringify({ data: { answer: 'Ветер 12 м/с.' } })));
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const ask = (text: string) => {
    const box = screen.getByPlaceholderText(/Опишите мечту/);
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
  };

  it('«Остановить» обрывает ожидание и говорит, что ответ не показан; «Ещё раз» задаёт тот же вопрос', async () => {
    render(<KuzmichClient />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Опишите мечту/)).toBeTruthy());
    ask('Погода на Авачинском?');
    fireEvent.click(await screen.findByRole('button', { name: 'Остановить' }));
    expect(await screen.findByText(TURN_STOPPED_TEXT)).toBeTruthy();
    expect(screen.queryByText('Нет связи. Попробуйте позже.')).toBeNull();

    hang = false;
    fireEvent.click(screen.getByRole('button', { name: 'Ещё раз' }));
    expect(await screen.findByText('Ветер 12 м/с.')).toBeTruthy();
    expect(posts.map((p) => p.message)).toEqual(['Погода на Авачинском?', 'Погода на Авачинском?']);
  });

  it('на «да» кнопки «Остановить» нет — сказано, что заявка уже уходит', async () => {
    render(<KuzmichClient />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Опишите мечту/)).toBeTruthy());
    ask('да');
    expect(await screen.findByText(/Ответ на «да» не останавливается/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Остановить' })).toBeNull();
  });
});
