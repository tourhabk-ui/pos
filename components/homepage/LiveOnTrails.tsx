'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, TrendingUp } from 'lucide-react';
import type { LiveFeedData } from '@/app/api/live-feed/route';
import { plural } from '@/lib/home/data-freshness';
import { liveCounters } from '@/lib/home/live-counters';

/**
 * Живые счётчики под турами: люди на маршрутах и брони за сутки.
 *
 * Аудит 24.09 (#36/#40): при нулях блок подставлял слова-заглушки —
 * «Маршруты / исследовать» и «Исследователь / Ваш стиль» (вторая даже не
 * ссылка), — и до первых продаж на проде он был ТОЛЬКО заглушкой: у
 * location_real_time_status.tourists_hour нет писателя, броней пока нет.
 * Социальное доказательство без данных — не доказательство.
 *
 * Теперь: каждый счётчик рисуется только при значении больше нуля; оба
 * нулевые (или данных нет) — блока нет вовсе. Отказ запроса не глушится,
 * а пишется в консоль (§4.0): «данных нет» и «запрос упал» различимы.
 * Склонение — plural(), «1 бронь / 2 брони / 5 броней».
 */
export function LiveOnTrails() {
  const [data, setData] = useState<LiveFeedData | null>(null);

  useEffect(() => {
    const load = () =>
      fetch('/api/live-feed')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((j: { ok?: boolean; data?: LiveFeedData }) => {
          if (j.ok && j.data) setData(j.data);
          else console.warn('[home] live-feed ответил без данных');
        })
        .catch((err: unknown) => {
          console.warn('[home] live-feed не загружен:', err instanceof Error ? err.message : err);
        });

    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const { touristsOnTrail, bookingsToday } = liveCounters(data);
  if (touristsOnTrail === 0 && bookingsToday === 0) return null;

  return (
    <div className="px-4 pb-4 max-w-6xl mx-auto flex flex-wrap gap-3">
      {touristsOnTrail > 0 && (
        <Link
          href="/routes"
          className="flex items-center gap-2.5 px-4 py-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors"
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--accent) 15%, var(--bg-primary))' }}>
            <Users size={15} className="text-[var(--accent)]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[var(--text-primary)] leading-tight lining-nums tabular-nums">
              {touristsOnTrail} {plural(touristsOnTrail, 'человек', 'человека', 'человек')}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">сейчас на маршрутах</p>
          </div>
        </Link>
      )}

      {bookingsToday > 0 && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--ocean) 15%, var(--bg-primary))' }}>
            <TrendingUp size={15} className="text-[var(--ocean)]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[var(--text-primary)] leading-tight lining-nums tabular-nums">
              {bookingsToday} {plural(bookingsToday, 'бронь', 'брони', 'броней')}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">за последние 24 ч</p>
          </div>
        </div>
      )}
    </div>
  );
}
