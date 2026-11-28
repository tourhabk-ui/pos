/**
 * Вопрос без сети ждёт в телефоне и уходит Кузьмичу, когда связь вернётся
 * (карт-бланш владельца 27.11, шаг 3). Правило — вызовом
 * lib/kuzmich/offline-queue и offlineKuzmichReply, экраны /kuzmich и
 * /ai-assistant — рендером с подменённой сетью.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import {
  WAITING_MAX, askedOfflineCaption, joinWaiting, parseWaiting, waitingKey, waitingReply, waitingStrip,
} from '@/lib/kuzmich/offline-queue';
import { OFFLINE_NO_ANSWER, offlineKuzmichReply } from '@/lib/kuzmich/offline-answer';
import { saveRouteFacts, type RouteFacts } from '@/lib/offline/route-facts';

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span role="img" aria-label={p.alt} /> }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  usePathname: () => '/catalog',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }) }));
vi.mock('@/lib/images/compress-client', () => ({
  compressImageToLimit: async (file: File) => ({ file, dataUrl: 'data:image/jpeg;base64,AAAA', compressed: false }),
}));

import KuzmichClient from '@/app/kuzmich/_KuzmichClient';
import AIAssistantPage from '@/app/ai-assistant/_AIAssistantClient';

const WEATHER = 'Какая завтра погода на Мутновском?';
const CAPTION_ONE = /^Задан без сети в \d{2}:\d{2} — отправлен, когда появилась связь\.$/;

describe('правило очереди', () => {
  it('из вкладки берётся только этот разговор, битое и пустое — мимо, не больше пяти', () => {
    const raw = JSON.stringify([
      { text: 'вопрос 1', askedAt: 1, session: 's1' },
      { text: 'чужой', askedAt: 2, session: 's2' },
      { text: '  ', askedAt: 3, session: 's1' },
      { text: 'без времени', session: 's1' },
      ...Array.from({ length: 8 }, (_, i) => ({ text: `ещё ${i}`, askedAt: 10 + i, session: 's1' })),
    ]);
    const got = parseWaiting(raw, 's1');
    expect(got.length).toBe(WAITING_MAX);
    expect(got[0]).toEqual({ text: 'вопрос 1', askedAt: 1, session: 's1' });
    expect(got.map((q) => q.text)).not.toContain('чужой');
    expect(parseWaiting('{не json', 's1')).toEqual([]);
    expect(parseWaiting(null, 's1')).toEqual([]);
  });

  it('несколько вопросов — одним сообщением, время — самого раннего', () => {
    expect(joinWaiting([])).toBeNull();
    expect(joinWaiting([
      { text: 'первый', askedAt: 500, session: 's' },
      { text: 'второй', askedAt: 200, session: 's' },
    ])).toEqual({ text: 'первый\nвторой', asked: { at: 200, count: 2 } });
  });

  it('слова: где ждёт вопрос, сколько ждут, когда задан', () => {
    expect(waitingReply('tab')).toMatch(/пока эта вкладка открыта/);
    expect(waitingReply('page')).toMatch(/пока эта страница открыта/);
    expect(waitingReply('tab')).toMatch(/112/);
    expect(waitingStrip(1)).toBe('Ждут связи: 1 вопрос — уйдут Кузьмичу, когда сеть вернётся.');
    expect(waitingStrip(3)).toMatch(/3 вопроса/);
    expect(waitingStrip(5)).toMatch(/5 вопросов/);
    expect(askedOfflineCaption({ at: Date.UTC(2026, 10, 27, 3, 5), count: 1 })).toMatch(CAPTION_ONE);
    expect(askedOfflineCaption({ at: Date.UTC(2026, 10, 27, 3, 5), count: 2 }))
      .toMatch(/^Заданы без сети с \d{2}:\d{2} — отправлены, когда появилась связь\.$/);
  });

  it('ждать связи встаёт только вопрос без ответа в телефоне', () => {
    const facts: RouteFacts[] = [{
      id: 'r1', title: 'Вулкан Мутновский', builtAt: null, savedAt: Date.UTC(2026, 10, 20), hazards: ['камнепад'],
      equipment: [], mchsRequired: true, mchsPhone: null, parkName: null, alerts: [], medical: [],
    }];
    expect(offlineKuzmichReply('рядом медведь').kind).toBe('protocol');
    expect(offlineKuzmichReply('какие опасности на Мутновском?', [], facts).kind).toBe('route');
    expect(offlineKuzmichReply('SOS').kind).toBe('none');
    expect(offlineKuzmichReply(WEATHER)).toEqual({ text: OFFLINE_NO_ANSWER, kind: 'none', lead: null });
  });

  it('вопрос назвал сохранённый маршрут, а ответа в карточке нет — «в сохранённом нет» над «вопрос ждёт»', () => {
    const facts: RouteFacts[] = [{
      id: 'r1', title: 'Вулкан Мутновский', builtAt: null, savedAt: Date.UTC(2026, 10, 20), hazards: ['камнепад'],
      equipment: [], mchsRequired: true, mchsPhone: null, parkName: null, alerts: [], medical: [],
    }];
    const reply = offlineKuzmichReply(WEATHER, [], facts);
    expect(reply.kind).toBe('none');
    expect(reply.lead).toMatch(/^В сохранённом в телефоне маршруте «Вулкан Мутновский» ответа на это нет/);
    expect(reply.text).toBe(`${reply.lead}\n\n${OFFLINE_NO_ANSWER}`);
    expect(waitingReply('tab', reply.lead)).toBe(`${reply.lead}\n\n${waitingReply('tab')}`);
    expect(waitingReply('page', null)).toBe(waitingReply('page'));
  });
});

describe('экраны: вопрос ждёт связи и уходит сам', () => {
  let online = false;
  let failFetch = false;
  let asked: string[] = [];
  let withPhoto: string[] = [];
  beforeEach(() => {
    online = false;
    failFetch = false;
    asked = [];
    withPhoto = [];
    sessionStorage.clear();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/api/ai/chat')) {
        if (!online || failFetch) {
          asked.push(`(не ушло) ${JSON.parse(String(init.body)).message}`);
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        const body = JSON.parse(String(init.body)) as { message: unknown; imageBase64?: unknown };
        const q = String(body.message);
        asked.push(q);
        if (body.imageBase64) withPhoto.push(q);
        return Promise.resolve(new Response(JSON.stringify({ data: { answer: `Ответ на: ${q}` } })));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: { messages: [] } })));
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const ask = (box: HTMLElement, text: string) => {
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
  };
  const netBack = async () => {
    online = true;
    await act(async () => { window.dispatchEvent(new Event('online')); });
  };
  const stored = () => sessionStorage.getItem(waitingKey('kuzmich'));

  it('/kuzmich: без сети вопрос встаёт ждать, с сетью уходит сам — с подписью, когда задан', async () => {
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    ask(box, WEATHER);
    expect(await screen.findByText(waitingReply('tab'))).toBeTruthy();
    expect(screen.getByText(waitingStrip(1))).toBeTruthy();
    expect(asked).toEqual([]);
    expect(JSON.parse(stored() ?? '[]')).toHaveLength(1);

    await netBack();
    expect(await screen.findByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
    expect(asked).toEqual([WEATHER]);
    expect(screen.getByText(CAPTION_ONE)).toBeTruthy();
    expect(screen.queryByText(waitingStrip(1))).toBeNull();
    expect(stored()).toBeNull();
  });

  it('/kuzmich: два вопроса без сети — одним сообщением', async () => {
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    ask(box, WEATHER);
    await screen.findByText(waitingStrip(1));
    ask(box, 'Где поесть в Елизово?');
    await screen.findByText(waitingStrip(2));
    await netBack();
    await waitFor(() => expect(asked).toEqual([`${WEATHER}\nГде поесть в Елизово?`]));
    expect(await screen.findByText(/^Заданы без сети с \d{2}:\d{2}/)).toBeTruthy();
  });

  it('/kuzmich: очередь полна — шестой вопрос не сохранён, и ответ этого не обещает', async () => {
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    for (let i = 1; i <= 5; i++) {
      ask(box, `Вопрос ${i}`);
      await screen.findByText(waitingStrip(i));
    }
    ask(box, 'Вопрос 6');
    expect(await screen.findByText(OFFLINE_NO_ANSWER)).toBeTruthy();
    expect(screen.getByText(waitingStrip(5))).toBeTruthy();
    expect(JSON.parse(stored() ?? '[]')).toHaveLength(5);
  });

  it('/kuzmich: вопрос из очереди уходит без фото, прикреплённого после него, и не стирает поле ввода', async () => {
    const { container } = render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    ask(box, WEATHER);
    await screen.findByText(waitingStrip(1));
    const file = new File(['x'], 'grib.jpg', { type: 'image/jpeg' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    const withImage = await screen.findByPlaceholderText(/Добавьте вопрос/);
    fireEvent.change(withImage, { target: { value: 'Что это за гриб?' } });
    await netBack();
    await waitFor(() => expect(asked).toEqual([WEATHER]));
    expect(await screen.findByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
    expect(withPhoto).toEqual([]);
    expect((screen.getByPlaceholderText(/Добавьте вопрос/) as HTMLTextAreaElement).value).toBe('Что это за гриб?');
  });

  it('/kuzmich: «Не отправлять» — вопрос не уходит, когда сеть вернётся', async () => {
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    ask(box, WEATHER);
    fireEvent.click(await screen.findByRole('button', { name: 'Не отправлять' }));
    expect(screen.queryByText(waitingStrip(1))).toBeNull();
    expect(stored()).toBeNull();
    await netBack();
    await new Promise((r) => setTimeout(r, 30));
    expect(asked).toEqual([]);
  });

  it('/kuzmich: на памятку и на факты сохранённого маршрута вопрос ждать не встаёт', async () => {
    saveRouteFacts({
      id: 'r1', title: 'Вулкан Мутновский', builtAt: null, savedAt: 0, hazards: ['камнепад'],
      equipment: ['каска'], mchsRequired: true, mchsPhone: null, parkName: null, alerts: [], medical: [],
    });
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    ask(box, 'рядом медведь');
    await screen.findByText(/Связи нет — отвечаю памяткой/);
    ask(box, 'Что взять на Мутновский?');
    await screen.findByText(/отвечаю по сохранённому в телефоне маршруту/);
    expect(screen.queryByText(/Ждут связи/)).toBeNull();
    await netBack();
    await new Promise((r) => setTimeout(r, 30));
    expect(asked).toEqual([]);
  });

  it('/kuzmich: вопрос про сохранённый маршрут без ответа в карточке — «в сохранённом нет», и он ждёт связи', async () => {
    saveRouteFacts({
      id: 'r1', title: 'Вулкан Мутновский', builtAt: null, savedAt: 0, hazards: ['камнепад'],
      equipment: ['каска'], mchsRequired: true, mchsPhone: null, parkName: null, alerts: [], medical: [],
    });
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    ask(box, WEATHER);
    await screen.findByText(/В сохранённом в телефоне маршруте «Вулкан Мутновский» ответа на это нет/);
    expect(screen.getByText(/Вопрос ждёт в телефоне и уйдёт Кузьмичу сам/)).toBeTruthy();
    expect(screen.getByText(waitingStrip(1))).toBeTruthy();
  });

  it('/kuzmich: ложная сеть — вопрос ждёт без повтора по кругу, уходит после первого настоящего ответа', async () => {
    online = true;
    failFetch = true;
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    ask(box, WEATHER);
    expect(await screen.findByText(waitingReply('tab'))).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([`(не ушло) ${WEATHER}`]);

    failFetch = false;
    ask(box, 'Как доехать до Паратунки?');
    await waitFor(() => expect(asked).toEqual([
      `(не ушло) ${WEATHER}`, 'Как доехать до Паратунки?', WEATHER,
    ]));
    expect(await screen.findByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
  });

  it('/kuzmich: вопрос с фото ждать не встаёт — без снимка он ушёл бы не тем вопросом', async () => {
    const { container } = render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    const file = new File(['x'], 'grib.jpg', { type: 'image/jpeg' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByPlaceholderText(/Добавьте вопрос/);
    ask(screen.getByPlaceholderText(/Добавьте вопрос/), 'Что это за гриб?');
    expect(await screen.findByText(OFFLINE_NO_ANSWER)).toBeTruthy();
    expect(screen.queryByText(/Ждут связи/)).toBeNull();
    expect(stored()).toBeNull();
    void box;
  });

  it('/kuzmich: страницу перезагрузили — вопрос этого разговора уходит, чужого разговора — нет', async () => {
    localStorage.setItem('th_kuzmich_session', 'sess-1');
    sessionStorage.setItem(waitingKey('kuzmich'), JSON.stringify([
      { text: WEATHER, askedAt: Date.now() - 60_000, session: 'sess-1' },
      { text: 'вопрос другого разговора', askedAt: Date.now() - 60_000, session: 'sess-0' },
    ]));
    online = true;
    render(<KuzmichClient />);
    expect(await screen.findByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
    expect(asked).toEqual([WEATHER]);
    expect(screen.getByText(CAPTION_ONE)).toBeTruthy();
  });

  it('/kuzmich: после перезагрузки вопрос ждёт истории разговора — пришедшая позже история его не затирает', async () => {
    localStorage.setItem('th_kuzmich_session', 'sess-1');
    sessionStorage.setItem(waitingKey('kuzmich'), JSON.stringify([{ text: WEATHER, askedAt: Date.now(), session: 'sess-1' }]));
    online = true;
    const post = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (init?.method === 'POST'
      ? post(url, init)
      : new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify({
        data: { messages: [{ role: 'user', content: 'Вчерашний вопрос' }, { role: 'assistant', content: 'Вчерашний ответ' }] },
      }))), 40)))));
    render(<KuzmichClient />);
    expect(await screen.findByText('Вчерашний ответ')).toBeTruthy();
    expect(await screen.findByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText('Вчерашний ответ')).toBeTruthy();
    expect(screen.getByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
  });

  it('/ai-assistant: вопрос из очереди не стирает то, что человек печатает', async () => {
    render(<AIAssistantPage />);
    const box = await screen.findByPlaceholderText('Спросите Кузьмича...');
    fireEvent.change(box, { target: { value: WEATHER } });
    fireEvent.submit(box.closest('form')!);
    await screen.findByText(waitingReply('tab'));
    fireEvent.change(box, { target: { value: 'Где поесть в Елизово' } });
    await netBack();
    expect(await screen.findByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
    expect((box as HTMLInputElement).value).toBe('Где поесть в Елизово');
  });

  it('/ai-assistant: вопрос про сохранённый маршрут без ответа в карточке — «в сохранённом нет» над «вопрос ждёт»', async () => {
    saveRouteFacts({
      id: 'r1', title: 'Вулкан Мутновский', builtAt: null, savedAt: 0, hazards: ['камнепад'],
      equipment: ['каска'], mchsRequired: true, mchsPhone: null, parkName: null, alerts: [], medical: [],
    });
    render(<AIAssistantPage />);
    const box = await screen.findByPlaceholderText('Спросите Кузьмича...');
    fireEvent.change(box, { target: { value: WEATHER } });
    fireEvent.submit(box.closest('form')!);
    await screen.findByText(/В сохранённом в телефоне маршруте «Вулкан Мутновский» ответа на это нет/);
    expect(screen.getByText(/Вопрос ждёт в телефоне и уйдёт Кузьмичу сам/)).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it('/ai-assistant: без сети вопрос ждёт, событие online отправляет его, хотя экран ещё считает сеть пропавшей', async () => {
    render(<AIAssistantPage />);
    const box = await screen.findByPlaceholderText('Спросите Кузьмича...');
    fireEvent.change(box, { target: { value: WEATHER } });
    fireEvent.submit(box.closest('form')!);
    expect(await screen.findByText(waitingReply('tab'))).toBeTruthy();
    expect(screen.getByText(waitingStrip(1))).toBeTruthy();
    expect(asked).toEqual([]);

    await netBack();
    expect(await screen.findByText(`Ответ на: ${WEATHER}`)).toBeTruthy();
    expect(asked).toEqual([WEATHER]);
    expect(screen.getByText(CAPTION_ONE)).toBeTruthy();
    expect(screen.queryByText(waitingStrip(1))).toBeNull();
    expect(sessionStorage.getItem(waitingKey('ai-assistant'))).toBeNull();
  });
});
