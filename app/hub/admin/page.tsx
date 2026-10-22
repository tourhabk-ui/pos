'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AccessDeniedCard } from '@/components/hub/AccessDeniedCard';
import {
  Shield, Users, FileText, Settings,
  TrendingUp, TrendingDown, Percent,
  Briefcase, Calendar, BarChart3, AlertCircle,
  ArrowUpRight, RefreshCw, AlertTriangle, UserCheck,
  Bell, Activity, MessageSquareText, CalendarDays,
  UserPlus, ShoppingCart, XCircle, Star, MapPin, BedDouble,
  Smartphone, RussianRuble,
  type LucideIcon,
} from 'lucide-react';
import DaySummaryStrip from './_DaySummary';

/* ═══════════════════════════════════════════
   Types
   ═══════════════════════════════════════════ */

interface MetricItem {
  value: number;
  change: number;
  trend: string;
}

interface DashboardData {
  metrics: {
    totalRevenue: MetricItem;
    totalBookings: MetricItem;
    activeUsers: MetricItem;
    conversionRate: MetricItem;
    pwaInstalls?: MetricItem;
  };
  charts: {
    topTours: Array<{ id: string; title: string; bookings: number; revenue: number }>;
  };
  recentActivities: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    timestamp: string;
  }>;
  alerts?: Array<{
    id: string;
    type: 'error' | 'warning' | 'info';
    title: string;
    message: string;
    actionUrl?: string;
    actionLabel?: string;
  }>;
  pendingTours?: number;
  pendingPartners?: number;
}

type Period = 7 | 30 | 90;

/* ═══════════════════════════════════════════
   Formatters
   ═══════════════════════════════════════════ */

function fmt(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat('ru-RU').format(value);
}

function fmtRub(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat('ru-RU').format(value);
}

function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/* ═══════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════ */

function Trend({ change, trend }: { change: number; trend: string }) {
  if (trend === 'neutral' || change === 0) {
    return <span className="text-[11px] text-[var(--text-muted)] tabular-nums">0.0%</span>;
  }
  const up = trend === 'up';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] tabular-nums font-medium ${
      up ? 'text-[var(--success)]' : 'text-[var(--danger)]'
    }`}>
      {up ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 7, label: '7 дн' },
  { value: 30, label: '30 дн' },
  { value: 90, label: '90 дн' },
];

interface KpiDef {
  key: string;
  label: string;
  icon: LucideIcon;
  format: (v: number) => string;
  suffix?: string;
  /** Существующий раздел админки, куда ведёт плитка (новых экранов не заводим). */
  href: string;
}

const KPI_DEFS: KpiDef[] = [
  {
    key: 'activeUsers', href: '/hub/admin/users', label: 'Новые пользователи', icon: Users,
    format: fmt,
  },
  {
    key: 'totalBookings', href: '/hub/admin/bookings', label: 'Бронирования', icon: CalendarDays,
    format: fmt,
  },
  {
    key: 'totalRevenue', href: '/hub/admin/finance', label: 'Выручка', icon: RussianRuble,
    format: fmtRub, suffix: ' \u20BD',
  },
  {
    key: 'conversionRate', href: '/hub/admin/analytics', label: 'Конверсия', icon: Percent,
    format: (v) => v.toFixed(1), suffix: '%',
  },
  {
    key: 'pwaInstalls', href: '/hub/admin/analytics', label: 'Установки PWA', icon: Smartphone,
    format: fmt,
  },
];

/* Activity type → icon + color */
function getActivityStyle(type: string): { icon: LucideIcon; dotColor: string } {
  switch (type) {
    case 'booking': case 'booking_created': case 'new_booking':
      return { icon: ShoppingCart, dotColor: 'bg-[var(--success)]' };
    case 'user': case 'user_registered': case 'new_user':
      return { icon: UserPlus, dotColor: 'bg-[var(--ocean)]' };
    case 'tour': case 'tour_created': case 'tour_updated':
      return { icon: MapPin, dotColor: 'bg-[var(--accent)]' };
    case 'review': case 'new_review':
      return { icon: Star, dotColor: 'bg-[var(--warning)]' };
    case 'cancel': case 'booking_cancelled':
      return { icon: XCircle, dotColor: 'bg-[var(--danger)]' };
    default:
      return { icon: Activity, dotColor: 'bg-[var(--text-muted)]' };
  }
}

/* ═══════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════ */

export default function AdminDashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 403 — не сбой загрузки, а «вы не в той роли». Раньше он попадал в общий
  // error и предлагал «Повторить», который не может помочь никогда.
  const [denied, setDenied] = useState(false);
  const [period, setPeriod] = useState<Period>(30);

  const fetchData = useCallback(async (p: Period) => {
    setLoading(true);
    setError('');
    setDenied(false);
    try {
      const res = await fetch(`/api/admin/dashboard?period=${p}`);
      if (res.status === 403) { setDenied(true); return; }
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Ошибка');
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(period); }, [fetchData, period]);

  const handlePeriod = (p: Period) => {
    setPeriod(p);
  };

  /* ── Skeleton ── */
  if (loading) {
    return (
      <div className="p-5 lg:p-6 space-y-5">
        {/* Header skeleton */}
        <div className="flex items-center justify-between">
          <div className="h-7 w-48 rounded bg-[var(--bg-hover)] animate-pulse" />
          <div className="h-8 w-32 rounded-lg bg-[var(--bg-hover)] animate-pulse" />
        </div>
        {/* KPI skeleton */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-[104px] rounded-lg bg-[var(--bg-card)] border border-[var(--border)] animate-pulse" />
          ))}
        </div>
        {/* Content skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 h-80 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] animate-pulse" />
          <div className="lg:col-span-2 h-80 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] animate-pulse" />
        </div>
        {/* Shortcuts skeleton */}
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="h-16 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  /* ── Не та роль ── */
  if (denied) return <AccessDeniedCard requiredRole="admin" />;

  /* ── Error ── */
  if (error) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="max-w-sm admin-glass rounded-2xl p-6 text-center">
          <div className="w-10 h-10 rounded-full bg-[var(--danger)]/10 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-5 h-5 text-[var(--danger)]" />
          </div>
          <p className="text-sm font-medium text-[var(--text-primary)] mb-1">Ошибка загрузки</p>
          <p className="text-xs text-[var(--text-muted)] mb-4">{error}</p>
          <button
            onClick={() => fetchData(period)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--accent)] bg-[var(--accent)]/10 rounded-md hover:bg-[var(--accent)]/15 transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Повторить
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const metrics = data.metrics;
  const maxBookings = Math.max(...data.charts.topTours.map(t => t.bookings), 1);
  const maxRevenue = Math.max(...data.charts.topTours.map(t => t.revenue), 1);

  const shortcuts = [
    { icon: Calendar, label: 'Бронирования', href: '/hub/admin/bookings', badge: 0 },
    { icon: Users, label: 'Пользователи', href: '/hub/admin/users', badge: 0 },
    { icon: FileText, label: 'Модерация', href: '/hub/admin/content/tours', badge: data.pendingTours ?? 0 },
    { icon: Briefcase, label: 'Партнёры', href: '/hub/admin/content/partners', badge: 0 },
    { icon: MessageSquareText, label: 'Отзывы', href: '/hub/admin/content/reviews', badge: 0 },
    { icon: BedDouble, label: 'Отзывы жилья', href: '/hub/admin/content/accommodation-reviews', badge: 0 },
    { icon: UserCheck, label: 'Операторы', href: '/hub/admin/operators', badge: data.pendingPartners ?? 0 },
    { icon: BarChart3, label: 'Аналитика', href: '/hub/admin/analytics', badge: 0 },
    { icon: RussianRuble, label: 'Финансы', href: '/hub/admin/finance', badge: 0 },
    { icon: Activity, label: 'Активность', href: '/hub/admin/activity', badge: 0 },
    { icon: Bell, label: 'Уведомления', href: '/hub/admin/notifications', badge: 0 },
    { icon: Settings, label: 'Настройки', href: '/hub/admin/settings', badge: 0 },
  ];

  return (
    <div className="p-4 lg:p-6 space-y-4 max-w-[1400px]">

      {/* ─── Header ─── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full admin-glass-chip flex items-center justify-center">
            <Shield className="w-4 h-4 text-[var(--text-secondary)]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)] tracking-tight leading-none">
              Панель управления
            </h1>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Обзор за {period} дней
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Period tabs */}
          <div className="flex admin-glass rounded-full p-0.5">
            {PERIOD_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handlePeriod(opt.value)}
                className={`px-2.5 py-1.5 text-[11px] font-medium rounded-full whitespace-nowrap transition-colors ${
                  period === opt.value
                    ? 'bg-[var(--text-primary)] text-[var(--bg-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => fetchData(period)}
            className="p-2 text-[var(--text-muted)] admin-glass rounded-2xl hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors"
            title="Обновить"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ─── За сутки: люди, MCP, A2A, Кузьмич (слово владельца 22.10) ─── */}
      <DaySummaryStrip />

      {/* ─── Pending banners ─── */}
      {((data.pendingTours ?? 0) > 0 || (data.pendingPartners ?? 0) > 0) && (
        <div className="flex flex-wrap gap-2">
          {(data.pendingTours ?? 0) > 0 && (
            <button
              onClick={() => router.push('/hub/admin/content/tours?pending=1')}
              className="admin-glass admin-glass--press flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-[var(--text-primary)] rounded-full"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--warning)]" />
              {data.pendingTours} {plural(data.pendingTours ?? 0, 'тур', 'тура', 'туров')} {(data.pendingTours ?? 0) % 10 === 1 && (data.pendingTours ?? 0) % 100 !== 11 ? 'ожидает' : 'ожидают'} модерации
              <ArrowUpRight className="w-3 h-3 opacity-60" />
            </button>
          )}
          {(data.pendingPartners ?? 0) > 0 && (
            <button
              onClick={() => router.push('/hub/admin/operators')}
              className="admin-glass admin-glass--press flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-[var(--text-primary)] rounded-full"
            >
              <UserCheck className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              {data.pendingPartners} {plural(data.pendingPartners ?? 0, 'партнёр', 'партнёра', 'партнёров')} на верификации
              <ArrowUpRight className="w-3 h-3 opacity-60" />
            </button>
          )}
        </div>
      )}

      {/* ─── AI Alerts ─── */}
      {data.alerts && data.alerts.length > 0 && (
        <div className="space-y-1.5">
          {data.alerts.map(alert => {
            const styles = {
              error: { bg: 'bg-[var(--danger)]/6', border: 'border-[var(--danger)]/15', text: 'text-[var(--danger)]' },
              warning: { bg: 'bg-[var(--warning)]/6', border: 'border-[var(--warning)]/15', text: 'text-[var(--warning)]' },
              info: { bg: 'bg-[var(--ocean)]/6', border: 'border-[var(--ocean)]/15', text: 'text-[var(--ocean)]' },
            };
            const s = styles[alert.type];
            return (
              <div
                key={alert.id}
                className={`flex items-center gap-2.5 px-3.5 py-2.5 text-xs border rounded-lg ${s.bg} ${s.border} ${s.text}`}
              >
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span className="font-semibold shrink-0">{alert.title}</span>
                <span className="opacity-70 flex-1 truncate">{alert.message}</span>
                {alert.actionUrl && (
                  <button
                    onClick={() => router.push(alert.actionUrl!)}
                    className="shrink-0 flex items-center gap-0.5 font-medium hover:underline"
                  >
                    {alert.actionLabel ?? 'Подробнее'} <ArrowUpRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── KPI Cards ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
        {KPI_DEFS.map((kpi) => {
          const m = metrics[kpi.key as keyof typeof metrics];
          // Метрика может отсутствовать (старый ответ API) — не роняем дашборд.
          if (!m) return null;
          const Icon = kpi.icon;
          return (
            <Link
              key={kpi.key}
              href={kpi.href}
              aria-label={`${kpi.label}: открыть раздел`}
              className="admin-glass admin-glass--press block no-underline rounded-2xl px-3.5 py-3 relative overflow-hidden [&:last-child:nth-child(odd)]:col-span-2 lg:[&:last-child:nth-child(odd)]:col-span-1"
            >
              {/* Icon top-right — цветная плашка на полной непрозрачности.
                  Раньше был нейтральный bg + opacity-60 с доводкой до 100% только
                  по hover: на тач-экране hover не срабатывает → значки почти не
                  видны (фидбэк владельца). Теперь тинт по цвету метрики. */}
              <div className={`absolute top-3 right-3 w-7 h-7 rounded-full admin-glass-chip flex items-center justify-center text-[var(--text-secondary)]`}>
                <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
              </div>

              {/* Label */}
              <p className="text-[11px] font-medium text-[var(--text-secondary)] mb-2 pr-8 leading-tight">
                {kpi.label}
              </p>

              {/* Value */}
              <p className="text-[26px] lg:text-[28px] font-semibold text-[var(--text-primary)] tabular-nums leading-none tracking-tight">
                {kpi.format(m.value)}{kpi.suffix && <span className="text-base font-normal text-[var(--text-muted)] ml-0.5">{kpi.suffix}</span>}
              </p>

              {/* Trend */}
              <div className="mt-2">
                <Trend change={m.change} trend={m.trend} />
              </div>
            </Link>
          );
        })}
      </div>

      {/* ─── Content: Tours + Activity ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* Top tours — 3 cols */}
        <div className="lg:col-span-3 admin-glass rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span className="text-xs font-semibold text-[var(--text-primary)]">Популярные туры</span>
            </div>
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{data.charts.topTours.length} шт</span>
          </div>
          {data.charts.topTours.length === 0 ? (
            <div className="px-4 py-16 text-center">
              <BarChart3 className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-2 opacity-40" />
              <p className="text-xs text-[var(--text-muted)]">Нет данных за выбранный период</p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {data.charts.topTours.map((tour, idx) => {
                const bookingPct = (tour.bookings / maxBookings) * 100;
                return (
                  <Link
                    key={tour.id}
                    href={`/hub/admin/content/tours?tour=${encodeURIComponent(tour.id)}&q=${encodeURIComponent(tour.title)}`}
                    className="flex items-center gap-3 px-4 py-3 no-underline [&_*]:no-underline text-inherit hover:bg-[var(--bg-hover)] transition-colors group"
                  >
                    {/* Rank */}
                    <span className={`w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold tabular-nums shrink-0 ${
                      idx === 0
                        ? 'bg-[var(--text-primary)] text-[var(--bg-primary)]'
                        : idx < 3
                          ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                          : 'text-[var(--text-muted)]'
                    }`}>
                      {idx + 1}
                    </span>

                    {/* Tour info + bar */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[var(--text-primary)] truncate mb-1.5">
                        {tour.title}
                      </p>
                      {/* Inline bar */}
                      <div className="h-1.5 bg-[var(--bg-hover)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--text-primary)]/35 rounded-full transition-all duration-500"
                          style={{ width: `${bookingPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <p className="text-[10px] text-[var(--text-muted)] leading-none mb-0.5">Броней</p>
                        <p className="text-xs font-semibold text-[var(--text-primary)] tabular-nums">{tour.bookings}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-[var(--text-muted)] leading-none mb-0.5">Выручка</p>
                        <p className="text-xs font-semibold text-[var(--text-primary)] tabular-nums">{fmtRub(tour.revenue)} &#8381;</p>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Activity — 2 cols */}
        <div className="lg:col-span-2 admin-glass rounded-2xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span className="text-xs font-semibold text-[var(--text-primary)]">Лента активности</span>
            </div>
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums">24ч</span>
          </div>
          <div className="flex-1 max-h-80 overflow-y-auto">
            {data.recentActivities.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <Activity className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-2 opacity-40" />
                <p className="text-xs text-[var(--text-muted)]">Нет активности</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {data.recentActivities.map((act) => {
                  const style = getActivityStyle(act.type);
                  return (
                    <div key={act.id} className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors">
                      {/* Status dot */}
                      <div className="pt-1 shrink-0">
                        <div className={`w-2 h-2 rounded-full ${style.dotColor}`} />
                      </div>
                      {/* Content */}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-[var(--text-primary)] leading-snug">{act.description}</p>
                        <p className="text-[10px] text-[var(--text-muted)] mt-1 tabular-nums">
                          {new Date(act.timestamp).toLocaleString('ru-RU', {
                            hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
                          })}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Quick Actions ─── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--text-muted)]">Быстрый доступ</p>
          <div className="h-px flex-1 bg-[var(--border)] ml-3" />
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {shortcuts.map((s) => {
            const Icon = s.icon;
            const hasBadge = s.badge > 0;
            return (
              <button
                key={s.href}
                onClick={() => router.push(s.href)}
                className="admin-glass admin-glass--press relative rounded-2xl px-2 py-2.5 flex flex-col items-center gap-1.5 text-center group"
              >
                <div className="w-8 h-8 rounded-full admin-glass-chip flex items-center justify-center">
                  <Icon className="w-4 h-4 text-[var(--text-secondary)]" />
                </div>
                <span className="text-[11px] text-[var(--text-secondary)] leading-tight font-medium">{s.label}</span>
                {hasBadge && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] text-[10px] font-bold flex items-center justify-center shadow-sm">
                    {s.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}
