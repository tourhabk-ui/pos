// @vitest-environment jsdom
/**
 * «Озвучить»: голос Ведара не ответил — читает голос телефона, и это сказано
 * (слово владельца 15.11 «голос не работает»).
 *
 * Проверка прода 189 в тот день: обе модели голоса Qwen — 403
 * `AllocationQuota.FreeTierOnly`, сервер отвечал кнопке 502, и человек слышал
 * тишину со строкой «Не удалось озвучить ответ».
 *
 * Сторож — рендером кнопки с подменой сети и синтеза речи телефона:
 *  - 502/503/429 и сеть не дошла — читает русский голос телефона, строка
 *    называет его; «Остановить» и конец фразы возвращают кнопку;
 *  - 400 — голос телефона не берётся: сервер текст не принял;
 *  - русского голоса нет, а без сети — только сетевой: честное «не удалось»;
 *  - голос Ведара ответил — голос телефона не говорит.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import SpeakButton, { DEVICE_VOICE_NOTE, SPEAK_FAILED_NOTE, TRUNCATED_NOTE } from '@/components/kuzmich/SpeakButton';
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

describe('голос Ведара не ответил — читает голос телефона', () => {
  it.each([502, 503, 429])('сервер %i: русский голос телефона читает ответ без разметки и адресов, строка называет голос', async (status) => {
    serverAnswers(status, 'Не удалось озвучить ответ. Текст остаётся на экране.');
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));

    await screen.findByText(DEVICE_VOICE_NOTE);
    const [u] = spoken();
    expect(spoken()).toHaveLength(1);
    expect(u!.text).toBe('Авачинский вулкан открыт. Экстренный вызов — 112. Подробнее:');
    expect(u!.voice).toBe(RU_LOCAL);
    expect(u!.lang).toBe('ru-RU');
    expect(screen.getByRole('button', { name: 'Остановить озвучку ответа' })).toBeTruthy();
  });

  it('конец фразы возвращает кнопку «Озвучить»', async () => {
    serverAnswers(502);
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await screen.findByText(DEVICE_VOICE_NOTE);
    act(() => { spoken()[0]!.onend?.(); });
    expect(screen.getByRole('button', { name: 'Озвучить ответ' })).toBeTruthy();
  });

  it('«Остановить» глушит голос телефона', async () => {
    serverAnswers(502);
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await screen.findByText(DEVICE_VOICE_NOTE);
    synth.cancel.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Остановить озвучку ответа' }));
    expect(synth.cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Озвучить ответ' })).toBeTruthy();
    // Остановка телефоном — не поломка: слов об ошибке нет.
    act(() => { spoken()[0]!.onerror?.({ error: 'interrupted' }); });
    expect(screen.queryByText(SPEAK_FAILED_NOTE)).toBeNull();
  });

  it('сеть не дошла — читает локальный русский голос', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    online = false;
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await screen.findByText(DEVICE_VOICE_NOTE);
    expect(spoken()[0]!.voice).toBe(RU_LOCAL);
  });

  it('длинный ответ: читается начало, и это признано', async () => {
    serverAnswers(503);
    const long = Array.from({ length: 80 }, (_, i) => `Предложение номер ${i + 1} про маршрут.`).join(' ');
    render(<SpeakButton text={long} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await screen.findByText(`${DEVICE_VOICE_NOTE} ${TRUNCATED_NOTE}`);
    expect(spoken()[0]!.text.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS);
  });
});

describe('когда голос телефона не берётся', () => {
  it('сервер 400 — запрос неверен, телефон не читает', async () => {
    serverAnswers(400, 'Нечего озвучивать');
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await screen.findByText('Нечего озвучивать');
    expect(spoken()).toHaveLength(0);
  });

  it('русского голоса на телефоне нет — честное «не удалось»', async () => {
    voices = [EN_LOCAL];
    serverAnswers(502);
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await screen.findByText(SPEAK_FAILED_NOTE);
    expect(spoken()).toHaveLength(0);
  });

  it('без сети только сетевой русский голос — он молчал бы, не берётся', async () => {
    voices = [RU_NETWORK];
    online = false;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await screen.findByText('Нет сети — озвучка недоступна, текст на экране.');
    expect(spoken()).toHaveLength(0);
  });

  it('голос Ведара ответил — телефон не говорит', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Uint8Array(2000), { status: 200, headers: { 'content-type': 'audio/wav', 'X-Speech-Truncated': '0' } }),
    ));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(<SpeakButton text={ANSWER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Озвучить ответ' }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Остановить озвучку ответа' });
    expect(spoken()).toHaveLength(0);
    expect(screen.queryByText(DEVICE_VOICE_NOTE)).toBeNull();
    play.mockRestore();
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
