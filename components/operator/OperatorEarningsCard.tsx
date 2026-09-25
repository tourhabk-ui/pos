/**
 * OperatorEarningsCard — сводка броней и выручки оператора за 30 дней.
 *
 * Карточки «Партнёрский трафик» и «Топ партнёры» убраны 25.09: сервер читал
 * affiliate_clicks по source, который никто не пишет, и они всегда
 * показывали ноль, выглядевший как измерение.
 */

'use client';

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';

interface EarningsData {
  periodDays: number;
  summary: {
    totalBookings: number;
    /** Только оплаченные и не отменённые брони. */
    totalRevenue: number;
    confirmedBookings: number;
    pendingBookings: number;
  };
  bookingsByDay: Array<{ date: string; total_bookings: number; total_revenue: string }>;
}

export function OperatorEarningsCard() {
  const [earnings, setEarnings] = useState<EarningsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchEarnings = async () => {
      try {
        const res = await fetch('/api/hub/operator/earnings');
        if (res.ok) {
          const data = await res.json();
          setEarnings(data);
        }
      } catch (err) {
        console.error('Failed to fetch earnings:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchEarnings();
    const interval = setInterval(fetchEarnings, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="ds-card p-6 rounded-lg">
        <div className="h-8 bg-[var(--bg-hover)] rounded animate-pulse"></div>
      </div>
    );
  }

  if (!earnings) {
    return (
      <div className="ds-card p-6 rounded-lg text-[var(--text-muted)]">
        Не удалось загрузить данные по доходам
      </div>
    );
  }

  const { summary, periodDays } = earnings;

  return (
    <div className="ds-card p-6 rounded-lg border border-[var(--border)]">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-[var(--success)]/10 flex items-center justify-center">
          <FileText className="w-5 h-5 text-[var(--success)]" />
        </div>
        <h3 className="font-semibold text-[var(--text-primary)]">Бронирования за {periodDays} дней</h3>
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Всего:</span>
          <span className="font-medium">{summary.totalBookings}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">Подтверждено:</span>
          <span className="text-[var(--success)]">{summary.confirmedBookings}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-muted)]">На рассмотрении:</span>
          <span className="text-[var(--warning)]">{summary.pendingBookings}</span>
        </div>
        <div className="border-t border-[var(--border)] pt-2 mt-2">
          <div className="flex justify-between font-semibold">
            <span>Прямых продаж за {periodDays} дней:</span>
            <span className="text-[var(--ocean)]">{summary.totalRevenue.toLocaleString('ru-RU')} ₽</span>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Только оплаченные брони, отменённые не входят
          </p>
        </div>
      </div>
    </div>
  );
}
