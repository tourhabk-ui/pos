'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MapPin, Star, Calendar, MessageCircle, Trophy, Leaf, ArrowRight, TrendingUp } from 'lucide-react';
import { EcoLevel } from '@/components/loyalty/EcoLevel';
import { AchievementBadge } from '@/components/loyalty/AchievementBadge';

interface Summary {
  bookings_count: number;
  bookings_completed: number;
  total_spent: number;
  eco_points: number;
  eco_level: number;
}

interface Achievement {
  id: string;
  name: string;
  description: string;
  points: number;
  unlockedAt?: string;
}

interface EcoData {
  totalPoints: number;
  level: number;
  achievements: Achievement[];
}

const QUICK_LINKS = [
  { href: '/routes', icon: MapPin, label: 'Маршруты', sub: 'Найти место' },
  { href: '/hub/tourist/bookings', icon: Calendar, label: 'Бронирования', sub: 'Мои туры' },
  { href: '/hub/tourist/reviews', icon: Star, label: 'Отзывы', sub: 'Мои оценки' },
  { href: '/ai-assistant', icon: MessageCircle, label: 'Кузьмич', sub: 'Спросить AI' },
];

export function MyKamchatkaClient() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [eco, setEco] = useState<EcoData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/tourist/summary').then(r => r.json()).then(j => j.ok ? setSummary(j.data) : null).catch(() => {}),
      fetch('/api/eco-points/user').then(r => r.json()).then(j => j.success ? setEco(j.data) : null).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const unlockedAchievements = eco?.achievements ?? [];

  return (
    <div className="ds-page py-6 space-y-6 max-w-2xl mx-auto">

      {/* Hero stat strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Туров', value: loading ? '—' : String(summary?.bookings_count ?? 0), icon: Calendar },
          { label: 'Завершено', value: loading ? '—' : String(summary?.bookings_completed ?? 0), icon: TrendingUp },
          { label: 'Eco-баллы', value: loading ? '—' : String(summary?.eco_points ?? 0), icon: Leaf },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="ds-card p-4 text-center">
            <Icon size={18} className="text-[var(--accent)] mx-auto mb-1" />
            <p className="text-xl font-bold text-[var(--text-primary)]">{value}</p>
            <p className="text-[11px] text-[var(--text-muted)]">{label}</p>
          </div>
        ))}
      </div>

      {/* Eco level */}
      {eco && (
        <div className="ds-card p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Trophy size={16} className="text-[var(--accent)]" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">Eco-уровень</span>
          </div>
          <EcoLevel level={eco.level} totalPoints={eco.totalPoints} />
        </div>
      )}

      {/* Achievements */}
      {unlockedAchievements.length > 0 && (
        <div className="ds-card p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)] mb-3">Достижения</p>
          <div className="grid grid-cols-2 gap-2">
            {unlockedAchievements.slice(0, 4).map(a => (
              <AchievementBadge
                key={a.id}
                name={a.name}
                description={a.description}
                points={a.points}
                unlockedAt={a.unlockedAt}
              />
            ))}
          </div>
          {unlockedAchievements.length > 4 && (
            <Link
              href="/hub/tourist/loyalty"
              className="flex items-center gap-1 mt-3 text-xs text-[var(--accent)] hover:underline"
            >
              Все достижения <ArrowRight size={12} />
            </Link>
          )}
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

      {/* Loyalty link if no achievements yet */}
      {unlockedAchievements.length === 0 && !loading && (
        <div className="ds-card p-4 text-center space-y-2">
          <Leaf size={24} className="text-[var(--success)] mx-auto" />
          <p className="text-sm font-medium text-[var(--text-primary)]">Начни зарабатывать Eco-баллы</p>
          <p className="text-xs text-[var(--text-muted)]">Бронируй туры, пиши отзывы, приглашай друзей</p>
          <Link href="/hub/tourist/loyalty" className="ds-btn ds-btn-primary text-xs px-4 py-2 inline-block mt-1">
            Программа лояльности
          </Link>
        </div>
      )}

    </div>
  );
}
