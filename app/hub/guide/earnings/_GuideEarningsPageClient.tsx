'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/admin/shared';
import { CreditCard, Wallet, TrendingUp, Calendar, Download, type LucideIcon } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';

interface EarningsSummary {
  totalEarnings: number;
  pendingPayment: number;
  toursCompleted: number;
  averagePerTour: number;
}

interface EarningsItem {
  id: string;
  tourName: string;
  date: string;
  amount: number;
  status: 'paid' | 'pending';
}

interface EarningsApiResponse {
  summary: EarningsSummary;
  items: EarningsItem[];
}

interface EarningsData {
  summary: EarningsSummary;
  earnings: EarningsItem[];
}

const EMPTY_SUMMARY: EarningsSummary = {
  totalEarnings: 0,
  pendingPayment: 0,
  toursCompleted: 0,
  averagePerTour: 0,
};

const SELECT = 'px-3.5 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';


/**
 * Статы в языке «Обзора»: иконка в чипе (--ocean на подложке), а не серый
 * глиф в углу — до этого четыре карточки выглядели чужими рядом с новым
 * дашбордом. Цвет цифры остаётся строго семантичным (vedar §7).
 */
function StatCard({ icon: Icon, value, label, valueColor }: {
  icon: LucideIcon; value: string; label: string; valueColor?: string;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10">
          <Icon className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
        </span>
        <span className="text-2xl font-bold" style={valueColor ? { color: valueColor } : undefined}>
          {value}
        </span>
      </div>
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

export default function GuideEarningsPageClient() {
  const [period, setPeriod] = useState('month');

  const { data, loading } = useApiFetch<EarningsApiResponse, EarningsData>(
    `/api/guide/earnings?period=${period}`,
    (d) => ({ summary: d?.summary ?? EMPTY_SUMMARY, earnings: d?.items ?? [] }),
  );

  const summary = data?.summary ?? EMPTY_SUMMARY;
  const earnings = data?.earnings ?? [];

  return (
    <div className="p-5 lg:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="ds-h1 flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-[var(--ocean)]" />
            Заработок
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Ваши доходы от проведения туров
          </p>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className={SELECT}
        >
          <option value="week">Неделя</option>
          <option value="month">Месяц</option>
          <option value="year">Год</option>
          <option value="all">Все время</option>
        </select>
      </div>

      {loading ? (
        <LoadingSpinner message="Загрузка данных..." />
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Wallet} value={`${summary.totalEarnings.toLocaleString('ru-RU')} ₽`} label="Всего заработано" valueColor="var(--success)" />
            <StatCard icon={CreditCard} value={`${summary.pendingPayment.toLocaleString('ru-RU')} ₽`} label="Ожидает выплаты" valueColor="var(--warning)" />
            <StatCard icon={Calendar} value={String(summary.toursCompleted)} label="Туров проведено" valueColor="var(--accent)" />
            <StatCard icon={TrendingUp} value={`${summary.averagePerTour.toLocaleString('ru-RU')} ₽`} label="Средний доход за тур" />
          </div>

          {/* Earnings List */}
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                История начислений
              </h2>
              <button className="inline-flex items-center gap-2 px-3 py-1.5 border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors text-xs">
                <Download className="w-3.5 h-3.5" />
                Экспорт
              </button>
            </div>

            {earnings.length === 0 ? (
              <div className="p-12 text-center text-[var(--text-muted)] text-sm">
                Нет данных за выбранный период
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {earnings.map((item) => (
                  <div
                    key={item.id}
                    className="px-5 py-4 flex items-center justify-between hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div>
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        {item.tourName}
                      </div>
                      <div className="text-xs text-[var(--text-muted)] mt-0.5">
                        {new Date(item.date).toLocaleDateString('ru-RU')}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className="text-sm font-bold"
                        style={{ color: item.status === 'paid' ? 'var(--success)' : 'var(--warning)' }}
                      >
                        {item.amount.toLocaleString('ru-RU')} ₽
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {item.status === 'paid' ? 'Выплачено' : 'Ожидает'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
