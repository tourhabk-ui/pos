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
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Square, Volume2 } from 'lucide-react';

type SpeakState = 'idle' | 'loading' | 'playing' | 'error';

/** Кто звучит сейчас — чтобы вторая кнопка остановила первую. */
let current: { stop: () => void } | null = null;

export default function SpeakButton({ text }: { text: string }) {
  const [state, setState] = useState<SpeakState>('idle');
  const [note, setNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function release() {
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

  async function speak() {
    if (state === 'playing' || state === 'loading') {
      self.current.stop();
      if (current === self.current) current = null;
      return;
    }
    if (current && current !== self.current) current.stop();
    current = self.current;

    setState('loading');
    setNote(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/ai/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setNote(body?.error ?? 'Не удалось озвучить ответ.');
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
      if (truncated) setNote('Озвучено начало ответа — полностью он на экране.');
      setState('playing');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      release();
      // Safari на iOS может не дать включить звук, пришедший после сетевого
      // ожидания: это не поломка голоса, и сказать надо именно это.
      const blocked = e instanceof DOMException && e.name === 'NotAllowedError';
      setNote(
        blocked ? 'Браузер не дал включить звук — нажмите ещё раз.'
        : navigator.onLine ? 'Не удалось озвучить ответ.'
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
