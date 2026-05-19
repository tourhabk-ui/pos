'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Users, Clock, ArrowRight, CheckCircle, AlertCircle } from 'lucide-react';

interface Booking {
  id: string;
  tourist_name: string | null;
  tourist_phone: string | null;
  participants: number;
  booking_status: string;
  final_price: number | null;
}

interface NextTour {
  tour_id: string;
  tour_title: string;
  booking_date: string;
  days_until: number;
  booking_count: number;
  total_participants: number;
  bookings: Booking[];
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  });
}

function DaysUntilBadge({ days }: { days: number }) {
  if (days === 0) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[var(--danger)]/10 text-[var(--danger)]">
        Сегодня
      </span>
    );
  }
  if (days === 1) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[var(--warning)]/10 text-[var(--warning)]">
        Завтра
      </span>
    );
  }
  if (days <= 3) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[var(--warning)]/10 text-[var(--warning)]">
        Через {days} дня
      </span>
    );
  }
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
      Через {days} дней
    </span>
  );
}

export function NextTourCard() {
  const [nextTour, setNextTour] = useState<NextTour | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/hub/operator/next-tour')
      .then(r => r.json())
      .then(d => { if (d.success) setNextTour(d.next_tour); })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="ds-card p-5 space-y-3 animate-pulse">
        <div className="ds-skeleton h-4 w-36 rounded" />
        <div className="ds-skeleton h-6 w-2/3 rounded" />
        <div className="ds-skeleton h-4 w-1/2 rounded" />
      </div>
    );
  }

  if (!nextTour) {
    return (
      <div className="ds-card p-5 flex items-start gap-3">
        <CalendarDays className="w-5 h-5 text-[var(--text-muted)] mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-[var(--text-primary)]">Ближайший тур</p>
          <p className="text-sm text-[var(--text-muted)] mt-1">Нет запланированных туров с бронированиями</p>
          <Link
            href="/hub/operator/tours"
            className="inline-flex items-center gap-1 text-xs text-[var(--ocean)] mt-2 hover:underline"
          >
            Мои туры <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-card p-5">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-[var(--accent)]" />
          <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
            Ближайший тур
          </span>
        </div>
        <DaysUntilBadge days={nextTour.days_until} />
      </div>

      <h3 className="font-playfair font-bold text-[var(--text-primary)] text-lg leading-tight mb-1">
        {nextTour.tour_title}
      </h3>

      <div className="flex items-center gap-4 text-sm text-[var(--text-secondary)] mb-4">
        <span className="flex items-center gap-1">
          <Clock className="w-3.5 h-3.5" />
          {formatDate(nextTour.booking_date)}
        </span>
        <span className="flex items-center gap-1">
          <Users className="w-3.5 h-3.5" />
          {nextTour.total_participants} чел.
        </span>
      </div>

      {nextTour.bookings.length > 0 && (
        <div className="space-y-2 mb-4">
          {nextTour.bookings.slice(0, 4).map(b => (
            <div
              key={b.id}
              className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-[var(--bg-hover)] text-sm"
            >
              {b.booking_status === 'confirmed' ? (
                <CheckCircle className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 text-[var(--warning)] shrink-0" />
              )}
              <span className="text-[var(--text-primary)] font-medium truncate flex-1">
                {b.tourist_name ?? 'Без имени'}
              </span>
              <span className="text-[var(--text-muted)] shrink-0">
                {b.participants} чел.
              </span>
            </div>
          ))}
          {nextTour.booking_count > 4 && (
            <p className="text-xs text-[var(--text-muted)] text-center">
              +{nextTour.booking_count - 4} ещё
            </p>
          )}
        </div>
      )}

      <Link
        href={`/hub/operator/bookings?date=${nextTour.booking_date}&tour_id=${nextTour.tour_id}`}
        className="ds-btn ds-btn-secondary w-full flex items-center justify-center gap-2 text-sm"
      >
        Открыть список <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}
