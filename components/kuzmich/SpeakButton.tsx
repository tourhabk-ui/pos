'use client';

/**
 * «Озвучить» под ответом Кузьмича (issue #1992) — одна кнопка на веб-чат и
 * виджет.
 *
 * Состояний четыре, и последнее обязано быть видно: «не удалось» не выдаётся
 * за тишину (§4.0). Иначе человек в поле нажмёт, ничего не услышит и решит,
 * что телефон молчит, — а причина была в сети или в потолке озвучек.
 *
 * Одновременно звучит один ответ: новая озвучка останавливает прежнюю.
 *
 * Читает голос телефона — первым, без запроса на сервер (слово владельца
 * 15.11: «голос лучше телефона», голос DeepSeek — «кринж»). Он бесплатный,
 * отвечает сразу, а локальный голос работает и без сети
 * (`lib/kuzmich/device-voice.ts`). Русского голоса на устройстве нет —
 * просим голос у сервера (`/api/ai/speak`); не ответил и он — «не удалось».
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Square, Volume2 } from 'lucide-react';
import { prepareSpeechText } from '@/lib/ai/speech-text';
import { loadDeviceVoices, pickRussianVoice } from '@/lib/kuzmich/device-voice';

type SpeakState = 'idle' | 'loading' | 'playing' | 'error';

export const TRUNCATED_NOTE = 'Озвучено начало ответа — полностью он на экране.';
export const SPEAK_FAILED_NOTE = 'Не удалось озвучить ответ. Текст остаётся на экране.';

function deviceSynth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  if (typeof SpeechSynthesisUtterance === 'undefined') return null;
  return window.speechSynthesis;
}

/** Кто звучит сейчас — чтобы вторая кнопка остановила первую. */
let current: { stop: () => void } | null = null;

export default function SpeakButton({ text }: { text: string }) {
  const [state, setState] = useState<SpeakState>('idle');
  const [note, setNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const deviceRef = useRef(false);

  function release() {
    if (deviceRef.current) {
      deviceRef.current = false;
      deviceSynth()?.cancel();
    }
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
  }

  const self = useRef({ stop: () => { release(); setState('idle'); } });

  useEffect(() => () => {
    release();
    if (current === self.current) current = null;
  }, []);

  /**
   * Голос телефона. false — его нет (нет синтеза, нет русского голоса, без
   * сети только сетевой голос), нечего читать или нажали «Остановить».
   */
  async function speakOnDevice(signal: AbortSignal): Promise<boolean> {
    const synth = deviceSynth();
    if (!synth) return false;
    const voice = pickRussianVoice(await loadDeviceVoices(synth), navigator.onLine);
    const { text: spoken, truncated } = prepareSpeechText(text);
    if (!voice || !spoken || signal.aborted) return false;
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.onend = () => {
      if (!deviceRef.current) return;
      deviceRef.current = false;
      setState('idle');
      if (current === self.current) current = null;
    };
    utterance.onerror = (ev) => {
      // «interrupted» и «canceled» — это наша же остановка, а не поломка.
      if (!deviceRef.current || ev.error === 'interrupted' || ev.error === 'canceled') return;
      deviceRef.current = false;
      setNote(SPEAK_FAILED_NOTE);
      setState('error');
    };
    synth.cancel();
    deviceRef.current = true;
    synth.speak(utterance);
    if (truncated) setNote(TRUNCATED_NOTE);
    setState('playing');
    return true;
  }

  async function speak() {
    if (state === 'playing' || state === 'loading') {
      self.current.stop();
      if (current === self.current) current = null;
      return;
    }
    if (current && current !== self.current) current.stop();
    current = self.current;

    // iOS даёт голосу телефона заговорить только из нажатия: пустая фраза в
    // момент нажатия открывает его, пока ждём список голосов.
    deviceSynth()?.speak(new SpeechSynthesisUtterance(''));

    setState('loading');
    setNote(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (await speakOnDevice(ctrl.signal)) return;
    if (ctrl.signal.aborted) return;

    // Русского голоса на устройстве нет. Без сети просить сервер бесполезно.
    if (!navigator.onLine) {
      setNote('Нет сети — озвучка недоступна, текст на экране.');
      setState('error');
      return;
    }
    try {
      const res = await fetch('/api/ai/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (ctrl.signal.aborted) return;
        setNote(body?.error ?? SPEAK_FAILED_NOTE);
        setState('error');
        return;
      }
      const truncated = res.headers.get('X-Speech-Truncated') === '1';
      const url = URL.createObjectURL(await res.blob());
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { release(); setState('idle'); if (current === self.current) current = null; };
      audio.onerror = () => { release(); setNote('Не удалось проиграть звук.'); setState('error'); };
      await audio.play();
      if (truncated) setNote(TRUNCATED_NOTE);
      setState('playing');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      release();
      // Safari на iOS может не дать включить звук, пришедший после сетевого
      // ожидания: это не поломка голоса, и сказать надо именно это.
      const blocked = e instanceof DOMException && e.name === 'NotAllowedError';
      setNote(
        blocked ? 'Браузер не дал включить звук — нажмите ещё раз.'
        : navigator.onLine ? SPEAK_FAILED_NOTE
        : 'Нет сети — озвучка недоступна, текст на экране.',
      );
      setState('error');
    }
  }

  const label = state === 'playing' ? 'Остановить' : state === 'loading' ? 'Готовлю голос' : 'Озвучить';
  const Icon = state === 'playing' ? Square : state === 'loading' ? Loader2 : Volume2;

  return (
    <div className="mt-1 flex flex-col items-start">
      <button
        type="button"
        onClick={speak}
        aria-label={state === 'playing' ? 'Остановить озвучку ответа' : 'Озвучить ответ'}
        aria-pressed={state === 'playing'}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-xs text-[var(--text-secondary)] transition-all duration-200 hover:text-[var(--ocean)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ocean)] active:scale-95"
      >
        <Icon
          className={`h-4 w-4 ${state === 'loading' ? 'motion-safe:animate-spin' : ''}`}
          aria-hidden="true"
        />
        {label}
      </button>
      {note && (
        <p role="status" className="px-2 text-xs text-[var(--text-secondary)]">
          {note}
        </p>
      )}
    </div>
  );
}
