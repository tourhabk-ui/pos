'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, Compass, TrendingUp } from 'lucide-react';
import type { LiveFeedData } from '@/app/api/live-feed/route';

export function LiveOnTrails() {
  const [data, setData] = useState<LiveFeedData | null>(null);

  useEffect(() => {
    const fetch_ = () =>
      fetch('/api/live-feed')
        .then(r => r.json())
        .then(j => { if (j.ok) setData(j.data); })
        .catch(() => {});

    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, []);

  const touristsOnTrail = data?.active_routes.reduce((s, r) => s + r.tourists_hour, 0) ?? 0;
  const bookingsToday = data?.bookings_today ?? 0;

  return (
    <div className="px-4 pb-4 grid grid-cols-2 gap-3">
      <Link
        href="/routes"
        className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)]/40 transition-colors"
      >
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--accent) 15%, var(--bg-primary))' }}>
          <Users size={15} className="text-[var(--accent)]" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--text-primary)] leading-tight">
            {touristsOnTrail > 0 ? `${touristsOnTrail} человек` : 'Маршруты'}
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">
            {touristsOnTrail > 0 ? 'сейчас на маршрутах' : 'исследовать'}
          </p>
        </div>
      </Link>

      <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border)]">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--ocean) 15%, var(--bg-primary))' }}>
          {bookingsToday > 0 ? (
            <TrendingUp size={15} className="text-[var(--ocean)]" />
          ) : (
            <Compass size={15} className="text-[var(--ocean)]" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--text-primary)] leading-tight">
            {bookingsToday > 0 ? `${bookingsToday} броней` : 'Исследователь'}
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">
            {bookingsToday > 0 ? 'за последние 24 ч' : 'Ваш стиль'}
          </p>
        </div>
      </div>
    </div>
  );
}
