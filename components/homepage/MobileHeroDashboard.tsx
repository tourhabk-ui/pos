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
    <section className="relative min-h-[58vh] w-full" aria-label="Кузьмич — AI-помощник">
      <Image
        src="/images/hero/IMG_20260316_133049.jpg"
        alt="Вулкан на Камчатке"
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-[var(--bg-primary)]" aria-hidden />

      <div className="relative z-10 flex min-h-[58vh] flex-col justify-end px-4 pb-5 pt-24">
        <div className="rounded-2xl border border-white/15 backdrop-blur-md bg-black/40 p-5">
          <h1 className="font-playfair text-3xl font-bold text-white">
            Привет. Я Кузьмич.
          </h1>
          <p className="mt-1 text-lg text-white/80">Куда отправимся?</p>

          <form
            onSubmit={submit}
            className="mt-4 flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-3"
          >
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Например: Долина гейзеров"
              className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder-white/50 outline-none"
              aria-label="Спросить Кузьмича"
            />
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
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/25 px-4 py-2 text-sm text-white transition-all duration-200 active:scale-95"
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
