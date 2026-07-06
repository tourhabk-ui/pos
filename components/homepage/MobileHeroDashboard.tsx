'use client';

/**
 * MobileHeroDashboard — AI-first hero мобильного Field OS дашборда.
 * Терминал Кузьмича на glass-панели поверх фото вулкана; ввод уводит в
 * /ai-assistant?q= (клиент ai-assistant читает ?q= и автоотправляет).
 *
 * Glassmorphism — осознанное решение владельца (2026-07-03), запрет снят,
 * см. CLAUDE.md §2: разрешён поверх фото и тёмных подложек.
 * Emoji из концепта заменены на lucide-иконки (решение владельца).
 */

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Flame, PawPrint, MountainSnow, Mic } from 'lucide-react';
import { useMobileAuth } from '@/contexts/MobileAuthContext';

// Web Speech API — нет в lib.dom TypeScript, объявляем минимально необходимое.
// Кнопка микрофона рендерится только если API реально доступен в браузере.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const QUICK_TAGS = [
  { icon: Flame,        label: 'Вулканы',  href: '/routes?kind=place&location_type=volcano' },
  { icon: PawPrint,     label: 'Медведи',  href: '/routes?q=' + encodeURIComponent('медведи') },
  { icon: MountainSnow, label: 'Хели-ски', href: '/routes?q=' + encodeURIComponent('хели-ски') },
];

export function MobileHeroDashboard() {
  const router = useRouter();
  const { status, firstName } = useMobileAuth();
  const [value, setValue] = useState('');
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setVoiceSupported(getSpeechRecognition() !== null);
    return () => { recognitionRef.current?.stop(); };
  }, []);

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'ru-RU';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) setValue(transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    router.push(q ? `/ai-assistant?q=${encodeURIComponent(q)}` : '/ai-assistant');
  };

  return (
    <section className="relative h-[60vh] w-full" aria-label="Кузьмич — AI-помощник">
      <Image
        src="/images/hero/IMG_20260316_133026.jpg"
        alt="Вулкан на Камчатке"
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-[var(--bg-primary)]" aria-hidden />

      <div className="relative z-10 flex h-full flex-col justify-end px-4 pb-5 pt-24">
        <div className="rounded-2xl border border-white/10 backdrop-blur-md bg-black/40 p-5">
          <h1 className="font-playfair text-3xl font-bold text-white">
            {status === 'auth' && firstName ? `Привет, ${firstName}! Я Кузьмич.` : 'Привет. Я Кузьмич.'}
          </h1>
          <p className="mt-1 text-lg text-white/60">Куда отправимся?</p>

          <form
            onSubmit={submit}
            className="mt-4 flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-3"
          >
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Например: Долина гейзеров"
              className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/40 outline-none"
              aria-label="Спросить Кузьмича"
            />
            {voiceSupported && (
              <button
                type="button"
                onClick={toggleVoice}
                aria-label={listening ? 'Остановить запись' : 'Продиктовать вопрос'}
                aria-pressed={listening}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-200 active:scale-95"
                style={{ color: listening ? 'var(--danger)' : 'white' }}
              >
                <Mic size={18} strokeWidth={1.5} className={listening ? 'animate-pulse' : undefined} />
              </button>
            )}
            <button
              type="submit"
              aria-label="Отправить Кузьмичу"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white transition-all duration-200 active:scale-95"
            >
              <ArrowUpRight size={20} strokeWidth={1.5} />
            </button>
          </form>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {QUICK_TAGS.map(({ icon: Icon, label, href }) => (
              <Link
                key={label}
                href={href}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/25 bg-white/5 px-4 py-2 text-sm text-white transition-all duration-200 active:scale-95"
              >
                <Icon size={15} strokeWidth={1.5} aria-hidden />
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
