// @vitest-environment jsdom
/**
 * «Озвучить»: читает голос телефона — первым, без запроса на сервер.
 *
 * Слово владельца 15.11, утром — «голос не работает»: обе модели голоса Qwen
 * отвечали 403 `AllocationQuota.FreeTierOnly`, и голос телефона стал запасным.
 * Вечером того же дня, послушав голос DeepSeek, — «голос лучше телефона,
 * диипсиик кринж»: голос телефона стал первым, DeepSeek снят.
 *
 * Сторож — рендером кнопки с подменой сети и синтеза речи телефона:
 *  - есть русский голос — он читает, сервер не зовётся, слов о «недоступном
 *    голосе Ведара» нет; «Остановить» и конец фразы возвращают кнопку;
 *  - без сети читает локальный русский голос;
 *  - русского голоса нет — голос просится у сервера; сервер отказал — его
 *    слова видны, а не тишина;
 *  - русского голоса нет и сети нет — «нет сети», сервер не зовётся.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import SpeakButton, { SPEAK_FAILED_NOTE, TRUNCATED_NOTE } from '@/components/kuzmich/SpeakButton';
import { pickRussianVoice } from '@/lib/kuzmich/device-voice';
import { SPEECH_MAX_CHARS } from '@/lib/ai/speech-text';

class FakeUtterance {
  text: string;
  voice: unknown = null;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  constructor(text: string) { this.text = text; }
}

type Voice = { lang: string; localService: boolean; name: string };
const RU_LOCAL: Voice = { lang: 'ru-RU', localService: true, name: 'Милена' };
const RU_NETWORK: Voice = { lang: 'ru-RU', localService: false, name: 'Google русский' };
const EN_LOCAL: Voice = { lang: 'en-US', localService: true, name: 'Samantha' };

let voices: Voice[];
let online: boolean;
const synth = {
  getVoices: vi.fn(() => voices),
  speak: vi.fn(),
  cancel: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

/** Фразы, которые телефон начал читать (без пустой фразы-ключа iOS). */
function spoken(): FakeUtterance[] {
  return synth.speak.mock.calls.map((c) => c[0] as FakeUtterance).filter((u) => u.text !== '');
}

function serverAnswers(status: number, error?: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(error ? { error } : {}), { status, headers: { 'content-type': 'application/json' } }),
  ));
}

const ANSWER = '**Авачинский вулкан** открыт. Экстренный вызов — 112. Подробнее: https://vedarai.ru/places/avachinsky';

beforeEach(() => {
  voices = [EN_LOCAL, RU_LOCAL];
  online = true;
  synth.getVoices.mockClear();
  synth.speak.mockClear();
  synth.cancel.mockClear();
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window.navigator, 'onLine', { get: () => online, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'speechSynthesis');
});

function serverAudio() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(new Uint8Array(2000), { status: 200, headers: { 'content-type': 'audio/wav', 'X-Speech-Truncated': '0' } }),
  ));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
}

function press() {
  fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
}

describe('голос телефона читает первым', () => {
  it('русский голос телефона читает ответ без разметки и адресов, сервер не зовётся', async () => {
    serverAudio();
    render(<SpeakButton text={ANSWER} />);
    press();

    await screen.findByRole('button', { name: 'Остановить озвучку ответа' });
    const [u] = spoken();
    expect(spoken()).toHaveLength(1);
    expect(u!.text).toBe('Авачинский вулкан открыт. Экстренный вызов — 112. Подробнее:');
    expect(u!.voice).toBe(RU_LOCAL);
    expect(u!.lang).toBe('ru-RU');
    expect(fetch).not.toHaveBeenCalled();
    // Голос телефона — основной: слов о «недоступном голосе» нет.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('конец фразы возвращает кнопку «Озвучить»', async () => {
    render(<SpeakButton text={ANSWER} />);
    press();
    await screen.findByRole('button', { name: 'Остановить озвучку ответа' });
    act(() => { spoken()[0]!.onend?.(); });
    expect(screen.getByRole('button', { name: 'Озвучить ответ' })).toBeTruthy();
  });

  it('«Остановить» глушит голос телефона', async () => {
    render(<SpeakButton text={ANSWER} />);
    press();
    await screen.findByRole('button', { name: 'Остановить озвучку ответа' });
    synth.cancel.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Остановить озвучку ответа' }));
    expect(synth.cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Озвучить ответ' })).toBeTruthy();
    // Остановка телефоном — не поломка: слов об ошибке нет.
    act(() => { spoken()[0]!.onerror?.({ error: 'interrupted' }); });
    expect(screen.queryByText(SPEAK_FAILED_NOTE)).toBeNull();
  });

  it('поломка голоса телефона посреди фразы — «не удалось», а не тишина', async () => {
    render(<SpeakButton text={ANSWER} />);
    press();
    await screen.findByRole('button', { name: 'Остановить озвучку ответа' });
    act(() => { spoken()[0]!.onerror?.({ error: 'synthesis-failed' }); });
    expect(screen.getByText(SPEAK_FAILED_NOTE)).toBeTruthy();
  });

  it('без сети читает локальный русский голос', async () => {
    serverAudio();
    online = false;
    voices = [RU_NETWORK, RU_LOCAL];
    render(<SpeakButton text={ANSWER} />);
    press();
    await screen.findByRole('button', { name: 'Остановить озвучку ответа' });
    expect(spoken()[0]!.voice).toBe(RU_LOCAL);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('длинный ответ: читается начало, и это признано', async () => {
    const long = Array.from({ length: 80 }, (_, i) => `Предложение номер ${i + 1} про маршрут.`).join(' ');
    render(<SpeakButton text={long} />);
    press();
    await screen.findByText(TRUNCATED_NOTE);
    expect(spoken()[0]!.text.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS);
  });
});

describe('русского голоса на телефоне нет — голос у сервера', () => {
  it('сервер ответил звуком — играет он', async () => {
    voices = [EN_LOCAL];
    serverAudio();
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<SpeakButton text={ANSWER} />);
    press();
    await waitFor(() => expect(play).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Остановить озвучку ответа' });
    expect(fetch).toHaveBeenCalledWith('/api/ai/speak', expect.objectContaining({ method: 'POST' }));
    expect(spoken()).toHaveLength(0);
    play.mockRestore();
  });

  it('синтеза речи в браузере нет вовсе — тоже сервер', async () => {
    Reflect.deleteProperty(window, 'speechSynthesis');
    serverAudio();
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<SpeakButton text={ANSWER} />);
    press();
    await waitFor(() => expect(play).toHaveBeenCalled());
    play.mockRestore();
  });

  it.each([502, 503, 429])('сервер %i — его слова видны', async (status) => {
    voices = [EN_LOCAL];
    serverAnswers(status, 'Голос сейчас недоступен. Текст остаётся на экране.');
    render(<SpeakButton text={ANSWER} />);
    press();
    await screen.findByText('Голос сейчас недоступен. Текст остаётся на экране.');
    expect(spoken()).toHaveLength(0);
  });

  it('сеть не дошла — честное «не удалось»', async () => {
    voices = [EN_LOCAL];
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<SpeakButton text={ANSWER} />);
    press();
    await screen.findByText(SPEAK_FAILED_NOTE);
  });

  it('без сети только сетевой русский голос — он молчал бы; сервер не зовётся', async () => {
    voices = [RU_NETWORK];
    online = false;
    serverAudio();
    render(<SpeakButton text={ANSWER} />);
    press();
    await screen.findByText('Нет сети — озвучка недоступна, текст на экране.');
    expect(spoken()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('выбор голоса телефона', () => {
  it('локальный русский первым; сетевой — только при сети', () => {
    expect(pickRussianVoice([RU_NETWORK, RU_LOCAL], true)).toBe(RU_LOCAL);
    expect(pickRussianVoice([RU_NETWORK], true)).toBe(RU_NETWORK);
    expect(pickRussianVoice([RU_NETWORK], false)).toBeNull();
    expect(pickRussianVoice([EN_LOCAL], true)).toBeNull();
    expect(pickRussianVoice([{ lang: 'ru', localService: true, name: 'x' }], false)).not.toBeNull();
    expect(pickRussianVoice([{ lang: 'rue-UA', localService: true, name: 'x' }], true)).toBeNull();
  });
});
