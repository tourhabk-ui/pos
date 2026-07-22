'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Map, CalendarDays, Users, CreditCard, Star, User,
  Cloud, Wind, Droplets, Eye, Loader2, type LucideIcon,
} from 'lucide-react';
import { Weather } from '@/types';
import { useOnboardingGuard } from '@/components/hub/usePartnerOnboarding';

// Быстрая навигация по разделам прямо на «Обзоре» — тот же формат, что в ЛК
// туриста: на телефоне сайдбар спрятан под бургер, а отсюда любой раздел в
// один тап. Разделы — реальные страницы кабинета гида (сайдбар в layout.tsx),
// без дублирующих вкладок. Сгруппировано по смыслу.
interface SectionLink { href: string; label: string; icon: LucideIcon }
const SECTION_GROUPS: Array<{ title: string; items: SectionLink[] }> = [
  {
    title: 'Работа',
    items: [
      { href: '/hub/guide/tours',    label: 'Мои туры',   icon: Map },
      { href: '/hub/guide/schedule', label: 'Расписание', icon: CalendarDays },
      { href: '/hub/guide/groups',   label: 'Группы',     icon: Users },
    ],
  },
  {
    title: 'Деньги и репутация',
    items: [
      { href: '/hub/guide/earnings', label: 'Заработок', icon: CreditCard },
      { href: '/hub/guide/reviews',  label: 'Отзывы',    icon: Star },
    ],
  },
  {
    title: 'Аккаунт',
    items: [
      { href: '/hub/guide/profile',  label: 'Профиль',   icon: User },
    ],
  },
];

function SectionTile({ href, label, icon: Icon }: SectionLink) {
  return (
    <Link
      href={href}
      className="group flex flex-col items-center justify-center gap-2.5 p-3 min-h-[96px] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg transition-all duration-200 hover:border-[var(--accent)]/50 hover:shadow-md hover:-translate-y-0.5 motion-reduce:hover:translate-y-0"
    >
      {/* Тёплый чип под иконкой: холодная вода (--ocean) в покое, лава (--accent) на наведении */}
      <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10 group-hover:bg-[var(--accent)]/12 transition-colors">
        <Icon className="w-[22px] h-[22px] text-[var(--ocean)] group-hover:text-[var(--accent)] transition-colors" strokeWidth={1.75} />
      </span>
      <span className="text-xs font-medium text-[var(--text-primary)] text-center leading-tight">{label}</span>
    </Link>
  );
}

function SectionsNav() {
  return (
    <div className="space-y-6">
      {SECTION_GROUPS.map((group) => (
        <div key={group.title}>
          {/* Editorial-заголовок группы: лавовая засечка + spaced-caps */}
          <p className="ds-label mb-3 flex items-center gap-2">
            <span className="w-4 h-px bg-[var(--accent)]/70" aria-hidden />
            {group.title}
          </p>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {group.items.map((item) => (
              <SectionTile key={item.href} {...item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Погода зоны — это СВОЙСТВО безопасности гида, а не украшение (vedar §7): гид
// ведёт группу в поле и обязан знать условия. Уровень безопасности красится
// строго семантично (success/warning/danger), не «для красоты».
const SAFETY_META: Record<string, { label: string; cls: string }> = {
  excellent: { label: 'Отличные условия', cls: 'text-[var(--success)]' },
  good:      { label: 'Хорошие условия',  cls: 'text-[var(--text-secondary)]' },
  moderate:  { label: 'Умеренные условия', cls: 'text-[var(--text-secondary)]' },
  difficult: { label: 'Сложные условия',  cls: 'text-[var(--warning)]' },
  dangerous: { label: 'Опасные условия',  cls: 'text-[var(--danger)]' },
};

function WeatherStrip({ weather }: { weather: Weather }) {
  const safety = SAFETY_META[weather.safetyLevel ?? 'good'] ?? SAFETY_META.good;
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10">
            <Cloud className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
          </span>
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {weather.temperature}°C · {weather.location}
            </p>
            <p className={`text-xs font-medium ${safety.cls}`}>{safety.label}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-1"><Wind className="w-3.5 h-3.5" /> {weather.windSpeed} км/ч</span>
          <span className="inline-flex items-center gap-1"><Droplets className="w-3.5 h-3.5" /> {weather.humidity}%</span>
          <span className="inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> {weather.visibility} км</span>
        </div>
      </div>
    </div>
  );
}

export default function GuideDashboardClient() {
  // Гейт онбординга: незаполненный профиль гида уводит в визард.
  const onboardingReady = useOnboardingGuard('/hub/guide/onboarding');
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/weather?lat=53.0375&lng=158.6556&location=Петропавловск-Камчатский')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active && d?.success) setWeather(d.data); })
      .catch(() => { /* погода необязательна — без неё карточка просто не рендерится */ });
    return () => { active = false; };
  }, []);

  if (!onboardingReady) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl lg:max-w-6xl mx-auto px-4 py-6 lg:py-8 space-y-6">
      <header>
        <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">Обзор</h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">Кабинет гида</p>
      </header>

      {/* Погода зоны как свойство безопасности гида (честно: нет данных — нет карточки) */}
      {weather && <WeatherStrip weather={weather} />}

      {/* Быстрая навигация по разделам — формат ЛК туриста */}
      <SectionsNav />
    </div>
  );
}
