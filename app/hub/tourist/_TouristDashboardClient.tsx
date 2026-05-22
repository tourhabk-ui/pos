'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Compass, Calendar, TrendingUp, Award, MapPin,
  Sun, Cloud, CloudRain, CloudSnow, Wind, Droplets,
  ChevronRight, RefreshCw, Target, Star, Heart,
  ShoppingBag, User, Clock, Zap,
} from 'lucide-react';
import Link from 'next/link';
import { Weather } from '@/types';
import RecommendationCard, { RecommendationCardSkeleton } from '@/components/tourist/RecommendationCard';
import type { RecommendedTour } from '@/lib/recommendations/engine';

interface TouristStats {
  overview: Record<string, unknown>;
  profile_summary: {
    loyalty_tier: string;
    loyalty_points: number;
    total_trips: number;
    total_spent: number;
    average_rating: number;
    member_since: string;
  };
  trips_timeline: Array<{ month: string; trips_count: number; total_spent: number }>;
  category_stats: Array<{ trip_type: string; count: number; avg_spent: number }>;
  recent_reviews: Array<{ id: string; tour_name: string; rating: number; comment: string; created_at: string }>;
  upcoming_trips: Array<{ id: string; title: string; status: string; start_date: string }>;
}

interface MyBooking {
  id: string;
  date: string;
  participants: number;
  totalPrice: number;
  status: string;
  tour: { id: string; name: string; difficulty: string; duration: number; images: string[] };
}

interface TouristProfile {
  name?: string;
  first_name?: string;
}

function fmtRub(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M ₽`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K ₽`;
  return `${new Intl.NumberFormat('ru-RU').format(v)} ₽`;
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function pluralDays(n: number) {
  if (n === 1) return 'день';
  if (n >= 2 && n <= 4) return 'дня';
  return 'дней';
}

const TIER_LABELS: Record<string, string> = {
  bronze: 'Бронза', silver: 'Серебро', gold: 'Золото', platinum: 'Платина',
};
const TIER_COLORS: Record<string, string> = {
  bronze: 'text-amber-600', silver: 'text-slate-400', gold: 'text-yellow-400', platinum: 'text-cyan-400',
};

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  pending:   { label: 'Ожидает',    cls: 'bg-[var(--warning)]/10 text-[var(--warning)]' },
  confirmed: { label: 'Подтверждён', cls: 'bg-[var(--success)]/10 text-[var(--success)]' },
  completed: { label: 'Завершён',   cls: 'bg-[var(--text-muted)]/10 text-[var(--text-muted)]' },
  cancelled: { label: 'Отменён',    cls: 'bg-[var(--danger)]/10 text-[var(--danger)]' },
};

function WeatherIcon({ condition, className }: { condition: string; className?: string }) {
  const c = className ?? 'w-5 h-5';
  const map: Record<string, React.ReactNode> = {
    clear: <Sun className={c} />, mostly_clear: <Sun className={c} />,
    partly_cloudy: <Cloud className={c} />, overcast: <Cloud className={c} />,
    rain: <CloudRain className={c} />, snow: <CloudSnow className={c} />,
  };
  return <>{map[condition] ?? <Cloud className={c} />}</>;
}

/* ── Skeleton ── */
function DashboardSkeleton() {
  return (
    <div className="max-w-5xl lg:max-w-6xl mx-auto px-4 py-6 lg:py-8 space-y-6 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-8 w-48 bg-[var(--bg-hover)] rounded-lg" />
          <div className="h-4 w-32 bg-[var(--bg-hover)] rounded" />
        </div>
        <div className="h-9 w-24 bg-[var(--bg-hover)] rounded-lg" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1,2,3,4].map(i => <div key={i} className="h-24 bg-[var(--bg-hover)] rounded-lg" />)}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-40 bg-[var(--bg-hover)] rounded-lg" />
        <div className="h-40 bg-[var(--bg-hover)] rounded-lg" />
      </div>
      <div className="h-64 bg-[var(--bg-hover)] rounded-lg" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1,2,3].map(i => <div key={i} className="h-56 bg-[var(--bg-hover)] rounded-lg" />)}
      </div>
    </div>
  );
}

/* ── Next trip countdown ── */
function NextTripWidget({ trips }: { trips: TouristStats['upcoming_trips'] }) {
  const next = trips.find(t => daysUntil(t.start_date) >= 0);
  if (!next) {
    return (
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 flex flex-col justify-between h-full">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-[var(--text-muted)]" />
          <p className="text-sm font-medium text-[var(--text-secondary)]">Следующая поездка</p>
        </div>
        <div>
          <p className="text-[var(--text-muted)] text-sm mb-3">Нет запланированных поездок</p>
          <Link href="/marketplace" className="text-sm font-semibold text-[var(--accent)] hover:underline">
            Найти тур →
          </Link>
        </div>
      </div>
    );
  }

  const days = daysUntil(next.start_date);
  const urgency = days === 0 ? 'danger' : days <= 3 ? 'warning' : days <= 14 ? 'accent' : 'ocean';
  const urgencyColor = `var(--${urgency})`;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-5 pointer-events-none"
        style={{ background: `linear-gradient(135deg, ${urgencyColor} 0%, transparent 60%)` }}
      />
      <div className="relative">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4" style={{ color: urgencyColor }} />
          <p className="text-sm font-medium text-[var(--text-secondary)]">Следующая поездка</p>
        </div>
        <p className="font-semibold text-[var(--text-primary)] mb-3 truncate">{next.title}</p>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-4xl font-bold font-playfair" style={{ color: urgencyColor }}>
            {days === 0 ? '!' : days}
          </span>
          {days > 0 && (
            <span className="text-lg text-[var(--text-secondary)]">{pluralDays(days)}</span>
          )}
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {days === 0 ? 'Сегодня!' : days === 1 ? 'Уже завтра' : `${new Date(next.start_date).toLocaleDateString('ru-RU')}`}
        </p>
      </div>
    </div>
  );
}

/* ── First-time onboarding card ── */
function OnboardingCard() {
  const steps = [
    { n: 1, title: 'Заполните профиль',    desc: 'Имя и телефон нужны оператору для связи',    href: '/hub/tourist/profile',    done: false },
    { n: 2, title: 'Выберите тур',         desc: 'Каталог: вулканы, рыбалка, вертолёт, медведи', href: '/marketplace',           done: false },
    { n: 3, title: 'Подключите Telegram',  desc: 'Кузьмич пришлёт статус брони и напоминания', href: '/hub/tourist/profile',    done: false },
  ];
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--accent)]/20 rounded-lg p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center shrink-0">
          <Compass className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Добро пожаловать на Камчатку!</h2>
          <p className="text-xs text-[var(--text-muted)]">Три шага для начала работы</p>
        </div>
      </div>
      <div className="space-y-3">
        {steps.map(step => (
          <Link
            key={step.n}
            href={step.href}
            className="flex items-center gap-4 p-3 rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/40 hover:bg-[var(--bg-hover)] transition-all group"
          >
            <div className="w-7 h-7 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] text-xs font-bold flex items-center justify-center shrink-0 group-hover:bg-[var(--accent)] group-hover:text-[var(--bg-primary)] transition-colors">
              {step.n}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">{step.title}</p>
              <p className="text-xs text-[var(--text-muted)]">{step.desc}</p>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0 group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all" />
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Quick actions ── */
const QUICK_ACTIONS = [
  { label: 'Найти тур',      href: '/marketplace',             icon: ShoppingBag, color: 'var(--accent)' },
  { label: 'Бронирования',   href: '/hub/tourist/bookings',    icon: Calendar,    color: 'var(--ocean)' },
  { label: 'Избранное',      href: '/hub/tourist/wishlist',    icon: Heart,       color: 'var(--danger)' },
  { label: 'Профиль',        href: '/hub/tourist/profile',     icon: User,        color: 'var(--success)' },
];

function QuickActions() {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
      <div className="flex items-center gap-2 mb-4">
        <Zap className="w-4 h-4 text-[var(--text-muted)]" />
        <p className="text-sm font-medium text-[var(--text-secondary)]">Быстрые действия</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {QUICK_ACTIONS.map(({ label, href, icon: Icon, color }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--bg-hover)] hover:bg-[var(--bg-primary)] border border-transparent hover:border-[var(--border)] transition-all group"
          >
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
              style={{ background: `color-mix(in srgb, ${color} 12%, transparent)` }}
            >
              <Icon className="w-3.5 h-3.5" style={{ color }} />
            </div>
            <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">{label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Main component ── */
export default function TouristDashboardClient() {
  const [stats, setStats] = useState<TouristStats | null>(null);
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendedTour[]>([]);
  const [profile, setProfile] = useState<TouristProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [recsLoading, setRecsLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [statsRes, bookingsRes, weatherRes, profileRes] = await Promise.allSettled([
      fetch('/api/tourist/stats'),
      fetch('/api/bookings/my'),
      fetch('/api/weather?lat=53.0375&lng=158.6556&location=Петропавловск-Камчатский'),
      fetch('/api/tourist/profile'),
    ]);
    if (statsRes.status === 'fulfilled') {
      const d = await statsRes.value.json();
      if (d.success) setStats(d.data);
    }
    if (bookingsRes.status === 'fulfilled') {
      const d = await bookingsRes.value.json();
      if (d.success) setBookings(d.data?.bookings?.slice(0, 5) ?? []);
    }
    if (weatherRes.status === 'fulfilled') {
      const d = await weatherRes.value.json();
      if (d.success) setWeather(d.data);
    }
    if (profileRes.status === 'fulfilled') {
      const d = await profileRes.value.json();
      if (d.success) setProfile(d.data);
    }
    setLoading(false);
  }, []);

  const fetchRecs = useCallback(async () => {
    setRecsLoading(true);
    try {
      const res = await fetch('/api/tourist/recommendations?limit=6');
      const d = await res.json();
      if (d.success) setRecommendations(d.data);
    } catch { /* ignore */ }
    setRecsLoading(false);
  }, []);

  useEffect(() => { fetchAll(); fetchRecs(); }, [fetchAll, fetchRecs]);

  if (loading) return <DashboardSkeleton />;

  const ps = stats?.profile_summary;
  const firstName = profile?.first_name ?? profile?.name?.split(' ')[0] ?? null;

  const kpis = ps ? [
    { label: 'Поездок',  value: String(ps.total_trips),                                    icon: MapPin,    color: 'var(--accent)' },
    { label: 'Потрачено', value: fmtRub(ps.total_spent),                                   icon: TrendingUp, color: 'var(--ocean)' },
    { label: 'Баллы',    value: new Intl.NumberFormat('ru-RU').format(ps.loyalty_points),  icon: Award,     color: 'var(--success)' },
    { label: 'Уровень',  value: TIER_LABELS[ps.loyalty_tier] ?? ps.loyalty_tier,           icon: Compass,   color: 'var(--warning)', extra: ps.loyalty_tier },
  ] : [];

  return (
    <div className="max-w-5xl lg:max-w-6xl mx-auto px-4 py-6 lg:py-8 space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">
            {firstName ? `Привет, ${firstName}!` : 'Личный кабинет'}
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {ps?.member_since
              ? `С нами с ${new Date(ps.member_since).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}`
              : 'Добро пожаловать на Камчатку'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {weather && (
            <div className="hidden sm:flex items-center gap-2 px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg">
              <WeatherIcon condition={weather.condition} className="w-4 h-4 text-[var(--accent)]" />
              <span className="text-sm font-semibold text-[var(--text-primary)]">{weather.temperature}°C</span>
              <span className="text-xs text-[var(--text-muted)]">ПК</span>
            </div>
          )}
          <button
            onClick={fetchAll}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-[var(--border)] bg-[var(--bg-card)] rounded-lg text-[var(--text-secondary)] hover:border-[var(--accent)] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Обновить</span>
          </button>
        </div>
      </div>

      {/* KPIs */}
      {kpis.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {kpis.map(kpi => {
            const Icon = kpi.icon;
            return (
              <div
                key={kpi.label}
                className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-4 relative overflow-hidden group hover:border-[var(--border-strong)] transition-colors"
              >
                <div
                  className="absolute top-0 left-0 w-1 h-full rounded-l-lg"
                  style={{ background: kpi.color }}
                />
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: kpi.color }} />
                  <p className="text-xs text-[var(--text-muted)] font-medium">{kpi.label}</p>
                </div>
                <p className={`text-xl sm:text-2xl font-bold font-playfair leading-none text-[var(--text-primary)] ${kpi.extra ? TIER_COLORS[kpi.extra] ?? '' : ''}`}>
                  {kpi.value}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Onboarding for brand-new users */}
      {!ps?.total_trips && bookings.length === 0 && (
        <OnboardingCard />
      )}

      {/* Next trip + Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NextTripWidget trips={stats?.upcoming_trips ?? []} />
        <QuickActions />
      </div>

      {/* Weather strip */}
      {weather && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-5 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <WeatherIcon condition={weather.condition} className="w-6 h-6 text-[var(--accent)]" />
              <div>
                <p className="text-sm font-semibold text-[var(--text-primary)]">Погода в Петропавловске-Камчатском</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {weather.temperature}°C · Ветер {weather.windSpeed} км/ч · Влажность {weather.humidity}%
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2.5 py-1 rounded-lg font-medium ${
                weather.safetyLevel === 'excellent' || weather.safetyLevel === 'good'
                  ? 'bg-[var(--success)]/10 text-[var(--success)]'
                  : weather.safetyLevel === 'difficult'
                    ? 'bg-[var(--warning)]/10 text-[var(--warning)]'
                    : 'bg-[var(--danger)]/10 text-[var(--danger)]'
              }`}>
                {weather.safetyLevel === 'excellent' ? 'Отлично для туров'
                  : weather.safetyLevel === 'good' ? 'Хорошие условия'
                  : weather.safetyLevel === 'difficult' ? 'Сложные условия'
                  : 'Опасно'}
              </span>
              <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                <Wind className="w-3.5 h-3.5" />{weather.windSpeed}
                <Droplets className="w-3.5 h-3.5 ml-1" />{weather.humidity}%
              </div>
            </div>
          </div>
          {weather.recommendations && weather.recommendations.length > 0 && (
            <p className="text-xs text-[var(--text-secondary)] mt-2 leading-relaxed">
              {weather.recommendations[0]}
            </p>
          )}
        </div>
      )}

      {/* My bookings */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Мои бронирования</h2>
          <Link href="/hub/tourist/bookings" className="flex items-center gap-1 text-sm text-[var(--accent)] hover:underline font-medium">
            Все <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
        {bookings.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Calendar className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-sm text-[var(--text-muted)] mb-3">Бронирований пока нет</p>
            <Link href="/marketplace" className="text-sm font-semibold text-[var(--accent)] hover:underline">
              Найти тур →
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {bookings.map(b => {
              const st = STATUS_LABELS[b.status] ?? STATUS_LABELS.pending;
              return (
                <Link key={b.id} href="/hub/tourist/bookings" className="flex items-center gap-4 px-5 py-3.5 hover:bg-[var(--bg-hover)] transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{b.tour.name}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      {new Date(b.date).toLocaleDateString('ru-RU')} · {b.participants} чел.
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-lg shrink-0 ${st.cls}`}>{st.label}</span>
                  <span className="text-sm font-semibold text-[var(--text-primary)] shrink-0">{fmtRub(b.totalPrice)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Recommendations */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Рекомендуем вам</h2>
          </div>
          <Link href="/marketplace" className="text-sm text-[var(--accent)] hover:underline font-medium">
            Все туры →
          </Link>
        </div>
        {recsLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => <RecommendationCardSkeleton key={i} />)}
          </div>
        ) : recommendations.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {recommendations.slice(0, 3).map(tour => (
              <RecommendationCard key={tour.id} tour={tour} />
            ))}
          </div>
        ) : (
          <div className="text-center py-10 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg">
            <Star className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-sm text-[var(--text-muted)]">Рекомендации появятся после первого бронирования</p>
          </div>
        )}
      </div>

      {/* Recent reviews */}
      {stats?.recent_reviews && stats.recent_reviews.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Мои отзывы</h2>
            <Link href="/hub/tourist/reviews" className="flex items-center gap-1 text-sm text-[var(--accent)] hover:underline font-medium">
              Все <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {stats.recent_reviews.slice(0, 3).map(review => (
              <div key={review.id} className="px-5 py-3.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate pr-2">{review.tour_name}</span>
                  <span className="flex gap-0.5 text-[var(--warning)] shrink-0">
                    {Array.from({ length: review.rating }).map((_, i) => (
                      <Star key={i} size={12} fill="currentColor" strokeWidth={0} />
                    ))}
                  </span>
                </div>
                {review.comment && (
                  <p className="text-xs text-[var(--text-muted)] truncate">{review.comment}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
