'use client';

import React from 'react';
import { OperatorMetrics } from '@/types/operator';
import {
  Mountain,
  CalendarCheck,
  Clock,
  CheckCircle,
  Wallet,
  TrendingUp,
  Star,
  MessageSquare,
  Zap,
  LucideIcon
} from 'lucide-react';

/**
 * Метрики оператора на дашборде.
 *
 * Прогулка оператором 11.09 (#1799) нашла здесь три выдумки разом:
 *
 * 1. Зелёная стрелка «↑100%» была НЕ ростом, а долей: `current / total * 100`.
 *    Рядом стоит переключатель «7 / 30 / 90 дней», и оператор с одной бронью
 *    читал это как динамику. Доля показывается словами («1 из 1 активен»),
 *    стрелок нет: сравнивать с прошлым периодом нечем, пока API не считает
 *    предыдущее окно — а рисовать сравнение, которого не делали, нельзя.
 * 2. «Средний рейтинг 0.0» при нуле отзывов — ноль звёзд тому, кого никто не
 *    оценивал. Теперь `averageRating: number | null`, и null печатается «—».
 * 3. «Общая выручка» считала неоплаченные брони. Теперь две карточки:
 *    выставлено и получено — и вторая сходится с экраном «Финансы».
 *
 * Раскладка: на телефоне две колонки вместо одной (десять карточек в столбец
 * давали 16 000 px прокрутки), подписи под цифрой — одной строкой.
 */

interface OperatorMetricsGridProps {
  metrics: OperatorMetrics;
  loading?: boolean;
}

interface MetricCardProps {
  title: string;
  value: string;
  icon: LucideIcon;
  iconColor: string;
  bgColor: string;
  /** Пояснение под цифрой: доля, срок, источник. Словами, без стрелок. */
  note?: string;
  suffix?: string;
}

function MetricCard({ title, value, icon: Icon, iconColor, bgColor, note, suffix }: MetricCardProps) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 sm:p-5 hover:bg-[var(--bg-hover)] transition-colors duration-200">
      <div className={`inline-flex p-2 rounded-lg mb-3 ${bgColor}`}>
        <Icon className={`w-4 h-4 sm:w-5 sm:h-5 ${iconColor}`} />
      </div>
      <div className="text-xl sm:text-2xl font-bold text-[var(--text-primary)] leading-tight">
        {value}{suffix}
      </div>
      <div className="text-xs sm:text-sm text-[var(--text-secondary)] mt-0.5">{title}</div>
      {note && <div className="text-[11px] text-[var(--text-muted)] mt-1">{note}</div>}
    </div>
  );
}

export function OperatorMetricsGrid({ metrics, loading = false }: OperatorMetricsGridProps) {
  const formatCurrency = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
    return value.toLocaleString('ru-RU');
  };

  const share = (part: number, whole: number, noun: string): string | undefined =>
    whole > 0 ? `${part} из ${whole} ${noun}` : undefined;

  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {[...Array(8)].map((_, metricIndex) => (
          <div key={`skeleton-${metricIndex}`} className="bg-[var(--bg-card)] rounded-lg p-4 sm:p-5 animate-pulse">
            <div className="w-9 h-9 bg-[var(--bg-hover)] rounded-lg mb-3" />
            <div className="h-6 bg-[var(--bg-hover)] rounded w-16 mb-2" />
            <div className="h-3 bg-[var(--bg-card)] rounded w-24" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <MetricCard
        title="Активные туры"
        value={String(metrics.activeTours)}
        icon={Mountain}
        iconColor="text-[var(--success)]"
        bgColor="bg-[var(--success)]/10"
        note={share(metrics.activeTours, metrics.totalTours, 'всего')}
      />

      <MetricCard
        title="Всего бронирований"
        value={String(metrics.totalBookings)}
        icon={CalendarCheck}
        iconColor="text-[var(--accent)]"
        bgColor="bg-[var(--accent)]/10"
      />

      <MetricCard
        title="Подтверждено"
        value={String(metrics.confirmedBookings)}
        icon={CheckCircle}
        iconColor="text-[var(--success)]"
        bgColor="bg-[var(--success)]/10"
        note={share(metrics.confirmedBookings, metrics.totalBookings, 'броней')}
      />

      <MetricCard
        title="Ожидают подтверждения"
        value={String(metrics.pendingBookings)}
        icon={Clock}
        iconColor={metrics.pendingBookings > 0 ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}
        bgColor={metrics.pendingBookings > 0 ? 'bg-[var(--warning)]/10' : 'bg-[var(--bg-hover)]'}
        note={metrics.pendingBookings > 0 ? 'ответьте туристу' : undefined}
      />

      <MetricCard
        title="Выставлено по броням"
        value={formatCurrency(metrics.totalRevenue)}
        icon={Wallet}
        iconColor="text-[var(--text-secondary)]"
        bgColor="bg-[var(--bg-hover)]"
        suffix=" ₽"
        note="включая неоплаченные"
      />

      <MetricCard
        title="Получено"
        value={formatCurrency(metrics.paidRevenue)}
        icon={TrendingUp}
        iconColor="text-[var(--accent)]"
        bgColor="bg-[var(--accent)]/10"
        suffix=" ₽"
        note={`за период: ${formatCurrency(metrics.paidRevenueMonth)} ₽`}
      />

      <MetricCard
        title="Средний рейтинг"
        value={metrics.averageRating === null ? '—' : metrics.averageRating.toFixed(1)}
        icon={Star}
        iconColor={metrics.averageRating === null ? 'text-[var(--text-muted)]' : 'text-[var(--warning)]'}
        bgColor={metrics.averageRating === null ? 'bg-[var(--bg-hover)]' : 'bg-[var(--warning)]/10'}
        note={metrics.averageRating === null ? 'ещё никто не оценивал' : undefined}
      />

      <MetricCard
        title="Всего отзывов"
        value={String(metrics.totalReviews)}
        icon={MessageSquare}
        iconColor="text-[var(--ocean)]"
        bgColor="bg-[var(--ocean)]/10"
      />

      <MetricCard
        title="Новых лидов сегодня"
        value={String(metrics.newLeadsToday ?? 0)}
        icon={Zap}
        iconColor="text-[var(--ocean)]"
        bgColor="bg-[var(--ocean)]/10"
      />

      <MetricCard
        title="Необработанных лидов"
        value={String(metrics.unprocessedLeads ?? 0)}
        icon={Clock}
        iconColor={(metrics.unprocessedLeads ?? 0) > 0 ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}
        bgColor={(metrics.unprocessedLeads ?? 0) > 0 ? 'bg-[var(--warning)]/10' : 'bg-[var(--bg-hover)]'}
        note={(metrics.unprocessedLeads ?? 0) > 0 ? 'ждут ответа' : undefined}
      />
    </div>
  );
}
