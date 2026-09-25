'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Wallet, CreditCard, Users, Handshake, Receipt, Clock, XCircle,
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

/**
 * Метрики обзора агента (GET /api/agent/dashboard, разбор 26.09): продажи —
 * брони оператора с agent_user_id; выручка — только оплаченные и не
 * отменённые; вознаграждение — из единственной функции денег агента. Где
 * числа нет (ставка не назначена, нет оплаченных броней), приходит null и
 * показываются слова, а не «0 ₽».
 */
interface AgentMetrics {
  totalClients: number;
  activeClients: number;
  totalBookings: number;
  unpaidBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  paidBookings: number;
  paidRevenue: number;
  averageBookingValue: number | null;
}

interface AgentCommission {
  rate: number | null;
  waiting: number | null;
  payable: number | null;
  requested: number;
  paidOut: number;
  flagged: number;
}

interface AgentMetricsGridProps {
  period?: string;
}

function rub(v: number): string {
  return `${v.toLocaleString('ru-RU')} ₽`;
}

export function AgentMetricsGrid({ period = '30' }: AgentMetricsGridProps) {
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [commission, setCommission] = useState<AgentCommission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Состояние меняется только после ответа: синхронный setState в эффекте
  // даёт лишний проход рендера. «Повторить» выставляет загрузку само.
  const fetchMetrics = useCallback(() => {
    const params = new URLSearchParams({ period });
    return fetch(`/api/agent/dashboard?${params}`)
      .then(async (response) => {
        const result = await response.json().catch(() => null) as {
          success?: boolean; error?: string;
          data?: { metrics: AgentMetrics; commission: AgentCommission };
        } | null;
        if (response.ok && result?.success && result.data) {
          setMetrics(result.data.metrics);
          setCommission(result.data.commission);
          setError(null);
        } else {
          setError(result?.error ?? 'Ошибка загрузки метрик');
        }
      })
      .catch(() => setError('Сеть недоступна — метрики не загружены'))
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => {
    void fetchMetrics();
  }, [fetchMetrics]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner message="Загрузка метрик агента..." />
      </div>
    );
  }

  if (error || !metrics || !commission) {
    return (
      <div className="bg-[var(--bg-card)] border border-[var(--danger)]/30 rounded-lg p-6 text-center">
        <p className="text-[var(--danger)] mb-4">{error ?? 'Ошибка загрузки метрик'}</p>
        <button
          onClick={() => { setLoading(true); setError(null); void fetchMetrics(); }}
          className="px-4 py-2 border border-[var(--danger)]/30 text-[var(--danger)] rounded-md text-sm transition-colors hover:bg-[var(--bg-hover)]"
        >
          Повторить
        </button>
      </div>
    );
  }

  const earned = commission.rate === null
    ? null
    : (commission.waiting ?? 0) + (commission.payable ?? 0) + commission.requested + commission.paidOut;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <MetricCard
        title="Оплаченные продажи"
        value={rub(metrics.paidRevenue)}
        subtitle={`${metrics.paidBookings} броней за ${period} дней`}
        icon={<MetricIcon icon={Wallet} />}
        trend={metrics.paidRevenue > 0 ? 'up' : 'neutral'}
      />

      <MetricCard
        title="Вознаграждение"
        value={earned === null ? 'ставка не назначена' : rub(earned)}
        subtitle={commission.payable === null
          ? 'начисления не считаются'
          : `${rub(commission.payable)} можно запросить`}
        icon={<MetricIcon icon={CreditCard} />}
        trend={earned !== null && earned > 0 ? 'up' : 'neutral'}
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
        value={metrics.averageBookingValue === null ? 'нет оплаченных' : rub(metrics.averageBookingValue)}
        subtitle="по оплаченным броням"
        icon={<MetricIcon icon={Receipt} />}
        trend="neutral"
      />

      <MetricCard
        title="Ждёт оплаты"
        value={metrics.unpaidBookings.toString()}
        subtitle="бронирований"
        icon={<MetricIcon icon={Clock} />}
        trend="neutral"
      />

      <MetricCard
        title="Отменено"
        value={metrics.cancelledBookings.toString()}
        subtitle="бронирований"
        icon={<MetricIcon icon={XCircle} />}
        trend="neutral"
      />
    </div>
  );
}
