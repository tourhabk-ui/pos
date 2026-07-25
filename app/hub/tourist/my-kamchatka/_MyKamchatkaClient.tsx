'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MapPin, Star, Calendar, MessageCircle, Trophy, Leaf, ArrowRight, TrendingUp } from 'lucide-react';
import { EcoLevel } from '@/components/loyalty/EcoLevel';

interface Summary {
  bookings_count: number;
  bookings_completed: number;
  total_spent: number;
  /** Польза: тратится на скидку. */
  eco_utility: number;
  /** Вклад: накопленная история поступков, не тратится (docs/ECO.md). */
  eco_contribution: number;
}

const QUICK_LINKS = [
  { href: '/routes', icon: MapPin, label: 'Маршруты', sub: 'Найти место' },
  { href: '/hub/tourist/bookings', icon: Calendar, label: 'Бронирования', sub: 'Мои туры' },
  { href: '/hub/tourist/reviews', icon: Star, label: 'Отзывы', sub: 'Мои оценки' },
  { href: '/ai-assistant', icon: MessageCircle, label: 'Кузьмич', sub: 'Спросить AI' },
];

export function MyKamchatkaClient() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  // Один запрос вместо двух: /api/eco-points/user читал user_eco_points —
  // таблицу, которой нет ни в одной миграции. Оба слоя эко приходят в summary
  // из реестра.
  useEffect(() => {
    fetch('/api/tourist/summary')
      .then(r => r.json())
      .then(j => (j.ok ? setSummary(j.data) : null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="ds-page py-6 space-y-6 max-w-2xl mx-auto">

      {/* Hero stat strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Туров', value: loading ? '—' : String(summary?.bookings_count ?? 0), icon: Calendar },
          { label: 'Завершено', value: loading ? '—' : String(summary?.bookings_completed ?? 0), icon: TrendingUp },
          { label: 'Эко к трате', value: loading ? '—' : String(summary?.eco_utility ?? 0), icon: Leaf },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="ds-card p-4 text-center">
            <Icon size={18} className="text-[var(--accent)] mx-auto mb-1" />
            <p className="text-xl font-bold text-[var(--text-primary)]">{value}</p>
            <p className="text-[11px] text-[var(--text-muted)]">{label}</p>
          </div>
        ))}
      </div>

      {/* Вклад — то, что не тратится и остаётся с человеком */}
      {summary && summary.eco_contribution > 0 && (
        <div className="ds-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Trophy size={16} className="text-[var(--accent)]" />
              <div>
                <p className="text-sm font-semibold text-[var(--text-primary)]">Ваш вклад</p>
                <p className="text-[11px] text-[var(--text-muted)]">Не тратится и не сгорает</p>
              </div>
            </div>
            <p className="text-2xl font-bold text-[var(--text-primary)]">{summary.eco_contribution}</p>
          </div>
        </div>
      )}

      {/* Quick links */}
      <div className="ds-card p-4">
        <p className="text-sm font-semibold text-[var(--text-primary)] mb-3">Быстрые переходы</p>
        <div className="grid grid-cols-2 gap-2">
          {QUICK_LINKS.map(({ href, icon: Icon, label, sub }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 p-3 rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/40 hover:bg-[var(--bg-hover)] transition-colors"
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'color-mix(in srgb, var(--accent) 12%, var(--bg-primary))' }}
              >
                <Icon size={15} className="text-[var(--accent)]" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[var(--text-primary)] leading-tight">{label}</p>
                <p className="text-[10px] text-[var(--text-muted)]">{sub}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Призыв, пока вклада нет */}
      {!loading && (summary?.eco_contribution ?? 0) === 0 && (
        <div className="ds-card p-4 text-center space-y-2">
          <Leaf size={24} className="text-[var(--success)] mx-auto" />
          <p className="text-sm font-medium text-[var(--text-primary)]">Начните копить эко</p>
          <p className="text-xs text-[var(--text-muted)]">Бронируйте туры, пишите отзывы, приглашайте друзей</p>
          <Link href="/hub/tourist/loyalty" className="ds-btn ds-btn-primary text-xs px-4 py-2 inline-block mt-1">
            Программа лояльности
          </Link>
        </div>
      )}

    </div>
  );
}
