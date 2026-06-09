'use client';

import Link from 'next/link';
import { Mountain, Waves, Users, Camera, Fish, Sparkles } from 'lucide-react';

const MOODS = [
  {
    id: 'extreme',
    label: 'Хочу экстрима',
    sub: 'Восхождения, треккинг, хели',
    icon: Mountain,
    href: '/planner?mood=extreme',
    color: 'var(--accent)',
  },
  {
    id: 'relax',
    label: 'Хочу отдохнуть',
    sub: 'Термальные, рыбалка, природа',
    icon: Waves,
    href: '/planner?mood=relax',
    color: 'var(--ocean)',
  },
  {
    id: 'family',
    label: 'Семья с детьми',
    sub: 'Лёгкие маршруты, безопасно',
    icon: Users,
    href: '/planner?mood=family',
    color: 'var(--success)',
  },
  {
    id: 'photo',
    label: 'Фото-тур',
    sub: 'Вулканы, медведи, рассветы',
    icon: Camera,
    href: '/planner?mood=photo',
    color: 'var(--warning)',
  },
  {
    id: 'fishing',
    label: 'Рыбалка',
    sub: 'Лосось, нахлыст, реки',
    icon: Fish,
    href: '/hub/fishing',
    color: 'var(--ocean)',
  },
  {
    id: 'first',
    label: 'Первый раз',
    sub: 'С чего начать на Камчатке',
    icon: Sparkles,
    href: '/planner?mood=first',
    color: 'var(--accent)',
  },
] as const;

export function MoodEntry() {
  return (
    <section className="px-4 py-10 max-w-6xl mx-auto">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--accent)] mb-2">
          Куда вас тянет?
        </p>
        <h2 className="font-playfair text-2xl md:text-3xl font-bold text-[var(--text-primary)]">
          Выберите своё путешествие
        </h2>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {MOODS.map(mood => {
          const Icon = mood.icon;
          return (
            <Link
              key={mood.id}
              href={mood.href}
              className="ds-card flex flex-col items-center text-center gap-2.5 py-5 hover:border-[var(--accent)] transition-all group"
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-110"
                style={{
                  background: `color-mix(in srgb, ${mood.color} 12%, var(--bg-card))`,
                  color: mood.color,
                }}
              >
                <Icon size={20} />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--text-primary)] leading-snug">
                  {mood.label}
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-snug">
                  {mood.sub}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
