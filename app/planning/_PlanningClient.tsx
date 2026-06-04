'use client';

import React, { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { CheckCircle2, Circle, ArrowRight, ChevronRight, Star, Bell } from 'lucide-react';

const CHECKLIST = [
  { id: 'maps',   label: 'Карты скачаны',            sub: '450 МБ',             default: true  },
  { id: 'mchs',   label: 'МЧС регистрация оформлена', sub: '',                   default: true  },
  { id: 'offline',label: 'Маршрут сохранён офлайн',  sub: '',                   default: true  },
  { id: 'emg',    label: 'Контакты экстренных служб', sub: '112, МЧС Камчатки', default: false },
  { id: 'gear',   label: 'Проверка снаряжения',       sub: '',                   default: false },
];

const ROUTES = [
  { title: 'Авачинский вулкан',  image: '/images/bento/mutnovsky.jpg',  rating: 4.8, diff: 'Средняя', days: 2, href: '/routes?location_type=volcano'     },
  { title: 'Мутновский',        image: '/images/bento/mutnovsky.jpg',  rating: 4.6, diff: 'Лёгкая',  days: 1, href: '/routes?location_type=volcano'     },
  { title: 'Толбачик',          image: '/images/hero/hero-light.jpeg', rating: 4.9, diff: 'Сложная', days: 3, href: '/routes?location_type=volcano'     },
  { title: 'Халактырский',      image: '/images/bento/khalaktyr.jpg',  rating: 4.5, diff: 'Лёгкая',  days: 1, href: '/routes?category=morskie_progulki' },
];

const KUZMICH_TIP = 'На этой неделе открывается сезон нереста на Курильском озере. Лучшее время для наблюдения за медведями!';

// Circular progress
function Progress({ done, total }: { done: number; total: number }) {
  const r = 28, c = 2 * Math.PI * r;
  const pct = done / total;
  return (
    <svg width={72} height={72} viewBox="0 0 72 72">
      <circle cx={36} cy={36} r={r} fill="none" stroke="var(--border)" strokeWidth={5} />
      <circle cx={36} cy={36} r={r} fill="none" stroke="var(--accent)" strokeWidth={5}
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
        strokeLinecap="round" transform="rotate(-90 36 36)" />
      <text x={36} y={36} textAnchor="middle" dominantBaseline="central"
        fill="var(--text-primary)" fontSize={13} fontWeight="bold">
        {done}/{total}
      </text>
    </svg>
  );
}

export default function PlanningClient() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<string>('plan');

  useEffect(() => {
    const saved = localStorage.getItem('vedar_checklist');
    if (saved) {
      try { setChecked(JSON.parse(saved) as Record<string, boolean>); return; } catch {}
    }
    const init: Record<string, boolean> = {};
    CHECKLIST.forEach(c => { init[c.id] = c.default; });
    setChecked(init);
  }, []);

  function toggle(id: string) {
    setChecked(prev => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem('vedar_checklist', JSON.stringify(next));
      return next;
    });
  }

  const done = CHECKLIST.filter(c => checked[c.id]).length;

  if (mode === ('route' as string)) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="text-center px-8">
          <p className="text-[var(--text-muted)] mb-4">Режим "На маршруте" →</p>
          <Link href="/on-route" className="ds-btn ds-btn-primary">Открыть навигацию</Link>
          <button onClick={() => setMode('plan')} className="block mt-4 text-sm text-[var(--text-muted)] underline mx-auto">
            Вернуться к планированию
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--bg-primary)] pb-24">
      {/* Header */}
      <div className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 bg-[var(--bg-card)] border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <Link href="/" className="font-playfair font-bold text-[var(--text-primary)] text-lg">Vedar</Link>
          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full text-white"
            style={{ background: 'var(--success)' }}>AI Skill</span>
        </div>
        <div className="flex items-center gap-2">
          <Bell size={18} className="text-[var(--text-muted)]" />
        </div>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-1 mx-4 mt-4 p-1 rounded-xl bg-[var(--bg-hover)]">
        <button
          onClick={() => setMode('plan')}
          className="flex-1 py-2 rounded-lg text-xs font-bold transition-all"
          style={{ background: mode === 'plan' ? 'var(--bg-card)' : 'transparent',
                   color: mode === 'plan' ? 'var(--text-primary)' : 'var(--text-muted)',
                   boxShadow: mode === 'plan' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
          📋 Планирование
        </button>
        <button
          onClick={() => setMode('route')}
          className="flex-1 py-2 rounded-lg text-xs font-bold transition-all"
          style={{ background: mode === 'route' ? 'var(--bg-card)' : 'transparent',
                   color: mode === 'route' ? 'var(--text-primary)' : 'var(--text-muted)',
                   boxShadow: mode === 'route' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
          🧭 На маршруте
        </button>
      </div>

      <div className="px-4 mt-4 space-y-4">
        {/* Kuzmich recommendation */}
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <div className="relative h-36">
            <Image src="/images/bento/bears-kurilskoye.jpg" alt="Курильское озеро" fill className="object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 flex items-end gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl flex-shrink-0"
                style={{ background: 'var(--accent)' }}>🐻</div>
              <div>
                <p className="text-white/60 text-[10px] font-bold tracking-widest">КУЗЬМИЧ РЕКОМЕНДУЕТ</p>
                <p className="text-white text-sm leading-snug">{KUZMICH_TIP}</p>
              </div>
            </div>
          </div>
          <div className="p-4 bg-[var(--bg-card)]">
            <Link href="/routes?category=medvedi"
              className="flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold text-white transition-all hover:opacity-90"
              style={{ background: 'var(--accent)' }}>
              Собрать маршрут <ArrowRight size={15} />
            </Link>
          </div>
        </div>

        {/* Checklist */}
        <div className="bg-[var(--bg-card)] rounded-xl p-4" style={{ border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="font-bold text-[var(--text-primary)] text-sm">Готовность к походу</p>
              <p className="text-[10px] text-[var(--text-muted)]">{done} из {CHECKLIST.length} выполнено</p>
            </div>
            <Progress done={done} total={CHECKLIST.length} />
          </div>
          <div className="space-y-3">
            {CHECKLIST.map(item => (
              <button key={item.id} onClick={() => toggle(item.id)}
                className="w-full flex items-center gap-3 text-left">
                {checked[item.id]
                  ? <CheckCircle2 size={20} className="flex-shrink-0 text-[var(--success)]" />
                  : <Circle size={20} className="flex-shrink-0 text-[var(--border)]" />}
                <div className="min-w-0">
                  <p className={`text-sm font-medium leading-tight ${checked[item.id] ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                    {item.label}
                  </p>
                  {item.sub && <p className="text-[10px] text-[var(--text-muted)]">{item.sub}</p>}
                </div>
              </button>
            ))}
          </div>
          <Link href="/safety" className="flex items-center gap-1 mt-3 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors">
            <ChevronRight size={12} /> Ещё инструменты безопасности
          </Link>
        </div>

        {/* Popular routes */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="font-bold text-[var(--text-primary)] text-sm">Популярные маршруты</p>
            <Link href="/routes" className="text-xs text-[var(--accent)] font-semibold">Все маршруты →</Link>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
            {ROUTES.map(r => (
              <Link key={r.title} href={r.href}
                className="flex-shrink-0 w-44 rounded-xl overflow-hidden bg-[var(--bg-card)] hover:border-[var(--accent)]/40 transition-colors"
                style={{ border: '1px solid var(--border)' }}>
                <div className="relative h-28">
                  <Image src={r.image} alt={r.title} fill className="object-cover" />
                  <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                    style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
                    <Star size={9} className="fill-yellow-400 text-yellow-400" />
                    {r.rating}
                  </div>
                </div>
                <div className="p-3">
                  <p className="text-xs font-bold text-[var(--text-primary)] leading-tight truncate">{r.title}</p>
                  <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{r.days} д · {r.diff}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
