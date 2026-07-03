'use client';

/**
 * MobileHeroDashboard — AI-first hero мобильного Field OS дашборда.
 * Терминал Кузьмича поверх фото вулкана; ввод уводит в /ai-assistant?q=
 * (клиент ai-assistant читает ?q= и автоматически отправляет сообщение).
 *
 * Без glassmorphism: градиентный скрим поверх фото — та же идиома, что в
 * HeroStatus; панель ввода — сплошной var(--bg-card). Emoji из концепта
 * заменены на lucide-иконки (решение владельца).
 */

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Flame, PawPrint, MountainSnow } from 'lucide-react';

const QUICK_TAGS = [
  { icon: Flame,        label: 'Вулканы',  href: '/routes?kind=place&location_type=volcano' },
  { icon: PawPrint,     label: 'Медведи',  href: '/routes?q=' + encodeURIComponent('медведи') },
  { icon: MountainSnow, label: 'Хели-ски', href: '/routes?q=' + encodeURIComponent('хели-ски') },
];

export function MobileHeroDashboard() {
  const router = useRouter();
  const [value, setValue] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    router.push(q ? `/ai-assistant?q=${encodeURIComponent(q)}` : '/ai-assistant');
  };

  return (
    <section className="relative w-full" aria-label="Кузьмич — AI-помощник">
      <div className="relative h-[38vh] min-h-[240px] w-full">
        <Image
          src="/images/hero/IMG_20260316_133049.jpg"
          alt="Вулкан на Камчатке"
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/30 to-black/75" aria-hidden />
        <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
          <h1 className="font-playfair text-3xl font-bold text-white">
            Привет. Я Кузьмич.
          </h1>
          <p className="mt-1 text-lg text-white/85">Куда отправимся?</p>
        </div>
      </div>

      <div className="px-4 pt-3">
        <form
          onSubmit={submit}
          className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3"
        >
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Например: Долина гейзеров"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
            aria-label="Спросить Кузьмича"
          />
          <button
            type="submit"
            aria-label="Отправить Кузьмичу"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--accent)] transition-all duration-200 active:scale-95"
          >
            <ArrowUpRight size={20} strokeWidth={1.5} />
          </button>
        </form>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {QUICK_TAGS.map(({ icon: Icon, label, href }) => (
            <Link
              key={label}
              href={href}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2 text-sm text-[var(--text-primary)] transition-all duration-200 active:scale-95"
            >
              <Icon size={15} strokeWidth={1.5} aria-hidden className="text-[var(--accent)]" />
              {label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
