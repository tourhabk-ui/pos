/**
 * На /kuzmich ссылка на бота видна человеку, не только в JSON-LD шапки.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

vi.mock('next/image', () => ({
  default: (props: { alt?: string }) => <span role="img" aria-label={props.alt ?? ''} />,
}));

import KuzmichClient from '@/app/kuzmich/_KuzmichClient';
import { KUZMICH_TELEGRAM_URL } from '@/components/shared/KuzmichActions';

afterEach(() => {
  cleanup();
});

describe('/kuzmich', () => {
  it('показывает ссылку на Telegram-бота', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { messages: [] } }) }) as Response));
    Element.prototype.scrollIntoView = () => {};
    render(<KuzmichClient />);
    const link = await screen.findByRole('link', { name: 'Кузьмич в Telegram' });
    expect(link.getAttribute('href')).toBe(KUZMICH_TELEGRAM_URL);
    expect(link.textContent).toContain('Telegram');
  });

  it('Enter во время ответа не теряет следующее сообщение', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ message?: string; history?: Array<{ content: string }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/ai/chat') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { message?: string; history?: Array<{ content: string }> };
        calls.push(body);
        if (calls.length === 1) await gate;
        const answer = calls.length === 1 ? 'Туры на вулканы.' : '180 000 ₽';
        return { ok: true, json: async () => ({ data: { answer } }) } as Response;
      }
      return { ok: true, json: async () => ({ data: { messages: [] } }) } as Response;
    }));
    Element.prototype.scrollIntoView = () => {};
    render(<KuzmichClient />);
    const input = await screen.findByPlaceholderText('Опишите мечту о путешествии...');
    fireEvent.change(input, { target: { value: 'туры на вулканы' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText('туры на вулканы');
    fireEvent.change(input, { target: { value: 'Сколько стоит?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Сообщение уйдёт, когда Кузьмич допишет ответ.')).toBeTruthy();
    release();
    await screen.findByText('180 000 ₽');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.message).toBe('Сколько стоит?');
    expect(calls[1]?.history?.map((h) => h.content)).toContain('Туры на вулканы.');
  });
});
