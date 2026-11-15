/**
 * Шаги хода Кузьмича (#3412, п. 4): у каждого инструмента есть слова,
 * журнал хода сообщает о записях, клиент читает поток и старый JSON, и
 * страница /kuzmich показывает шаги, пока ответ не пришёл.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { observedToolRuns, readChatAnswer, sseEvent, stepLabel, STEP_TOOL_NAMES } from '@/lib/kuzmich/turn-steps';
import { KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <img alt={p.alt} /> }));
import KuzmichClient from '@/app/kuzmich/_KuzmichClient';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('слова шагов', () => {
  it('у каждого инструмента Кузьмича есть свои слова — не имя инструмента и не общее «проверяю»', () => {
    const missing = KUZMICH_TOOLS.map((t) => t.function.name).filter((n) => !STEP_TOOL_NAMES.has(n));
    expect(missing).toEqual([]);
    expect(stepLabel('нечто_новое')).toBe('Проверяю данные Ведара');
  });

  it('журнал хода сообщает о записи; одинаковый шаг подряд — один раз', () => {
    const seen: string[] = [];
    const runs = observedToolRuns<{ name: string; producedData: boolean }>((s) => seen.push(s));
    runs.push({ name: 'get_weather', producedData: true });
    runs.push({ name: 'get_weather', producedData: true }, { name: 'get_tours', producedData: false });
    expect(runs).toHaveLength(3);
    expect(seen).toEqual(['Смотрю погоду', 'Ищу туры']);
  });
});

describe('чтение ответа', () => {
  it('старый JSON без потока читается как раньше', async () => {
    const out = await readChatAnswer(new Response(JSON.stringify({ success: true }), { status: 429 }), () => {});
    expect(out).toEqual({ status: 429, body: { success: true } });
  });

  it('поток без итога — отказ, а не пустой ответ', async () => {
    const res = new Response(sseEvent({ type: 'step', label: 'Ищу туры' }), { headers: { 'content-type': 'text/event-stream' } });
    await expect(readChatAnswer(res, () => {})).rejects.toThrow(/без итога/);
  });
});

describe('страница /kuzmich', () => {
  it('пока ответ не пришёл — видны шаги; пришёл — ответ', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const enc = new TextEncoder();
    let push: (s: string) => void = () => {};
    let end: () => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return Promise.resolve(new Response(JSON.stringify({ data: { messages: [] } })));
      expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
      const body = new ReadableStream({
        start(c) { push = (s) => c.enqueue(enc.encode(s)); end = () => c.close(); },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    }));
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Опишите мечту/);
    fireEvent.change(box, { target: { value: 'Погода на Горелом?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(push).not.toBe(undefined));
    push(sseEvent({ type: 'step', label: 'Смотрю погоду' }));
    expect(await screen.findByText('Смотрю погоду')).toBeTruthy();
    push(sseEvent({ type: 'final', status: 200, body: { success: true, data: { answer: 'Ветер 5 м/с.' } } }));
    end();
    expect(await screen.findByText('Ветер 5 м/с.')).toBeTruthy();
    expect(screen.queryByText('Смотрю погоду')).toBeNull();
  });
});
