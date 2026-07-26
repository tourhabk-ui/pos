'use client';

import React, { useState, useEffect } from 'react';
import {
  Wallet, CreditCard, Users, Handshake, Receipt, Percent, Clock, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { MetricCard } from '../../admin/shared/MetricCard';
import { LoadingSpinner } from '../../admin/shared/LoadingSpinner';

// Икон-чип метрики — тот же язык, что чипы разделов кабинетов (vedar §9:
// lucide через --ocean, не эмодзи; здесь до этого жили огрызки вырезанных
// эмодзи — пустые строки и "[]" в слотах иконок).
function MetricIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex items-center justify-center w-9 h-9 rounded-full bg-[var(--ocean)]/10">
      <Icon className="w-[18px] h-[18px] text-[var(--ocean)]" strokeWidth={1.75} />
    </span>
  );
}

interface AgentMetrics {
  totalClients: number;
  activeClients: number;
  totalBookings: number;
  pendingBookings: number;
  confirmedBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  totalRevenue: number;
  monthlyRevenue: number;
  totalCommission: number;
  pendingCommission: number;
  averageBookingValue: number;
  conversionRate: number;
}

interface AgentMetricsGridProps {
  period?: string;
}

export function AgentMetricsGrid({ period = '30' }: AgentMetricsGridProps) {
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMetrics();
  }, [period]);

  const fetchMetrics = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ period });
      const response = await fetch(`/api/agent/dashboard?${params}`);
      const result = await response.json();

      if (result.success) {
        setMetrics(result.data.metrics);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Ошибка загрузки метрик');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner message="Загрузка метрик агента..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[var(--bg-card)] border border-[var(--danger)]/30 rounded-lg p-6 text-center">
        <p className="text-[var(--danger)] mb-4">Ошибка загрузки метрик</p>
        <button
          onClick={fetchMetrics}
          className="px-4 py-2 border border-[var(--danger)]/30 text-[var(--danger)] rounded-md text-sm transition-colors hover:bg-[var(--bg-hover)]"
        >
          Повторить
        </button>
      </div>
    );
  }

  if (!metrics) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <MetricCard
        title="Общий доход"
        value={`${metrics.totalRevenue.toLocaleString('ru-RU')} ₽`}
        subtitle={`за ${period} дней`}
        icon={<MetricIcon icon={Wallet} />}
        trend={metrics.totalRevenue > 0 ? 'up' : 'neutral'}
      />

      <MetricCard
        title="Комиссионные"
        value={`${metrics.totalCommission.toLocaleString('ru-RU')} ₽`}
        subtitle={`${metrics.pendingCommission.toLocaleString('ru-RU')} ₽ ожидает`}
        icon={<MetricIcon icon={CreditCard} />}
        trend={metrics.totalCommission > 0 ? 'up' : 'neutral'}
      />

      <MetricCard
        title="Клиенты"
        value={metrics.totalClients.toString()}
        subtitle={`${metrics.activeClients} активных`}
        icon={<MetricIcon icon={Users} />}
        trend={metrics.totalClients > 0 ? 'up' : 'neutral'}
      />

      <MetricCard
        title="Бронирования"
        value={metrics.totalBookings.toString()}
        subtitle={`${metrics.completedBookings} завершено`}
        icon={<MetricIcon icon={Handshake} />}
        trend={metrics.totalBookings > 0 ? 'up' : 'neutral'}
      />

      <MetricCard
        title="Средний чек"
        value={`${metrics.averageBookingValue.toLocaleString('ru-RU')} ₽`}
        subtitle="на бронирование"
        icon={<MetricIcon icon={Receipt} />}
        trend={metrics.averageBookingValue > 5000 ? 'up' : 'neutral'}
      />

      <MetricCard
        title="Конверсия"
        value={`${metrics.conversionRate.toFixed(1)}%`}
        subtitle="завершенных бронирований"
        icon={<MetricIcon icon={Percent} />}
        trend={metrics.conversionRate > 70 ? 'up' : 'down'}
      />

      <MetricCard
        title="Ожидает оплаты"
        value={metrics.pendingBookings.toString()}
        subtitle="бронирований"
        icon={<MetricIcon icon={Clock} />}
        trend={metrics.pendingBookings > 5 ? 'down' : 'neutral'}
      />

      <MetricCard
        title="Отменено"
        value={metrics.cancelledBookings.toString()}
        subtitle="бронирований"
        icon={<MetricIcon icon={XCircle} />}
        trend={metrics.cancelledBookings > metrics.totalBookings * 0.1 ? 'down' : 'neutral'}
      />
    </div>
  );
}

