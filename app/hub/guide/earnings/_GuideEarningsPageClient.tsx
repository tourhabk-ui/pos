'use client';

import { useState } from 'react';
import { LoadingSpinner } from '@/components/admin/shared';
import { CreditCard, Wallet, TrendingUp, Calendar, Download, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import { useApiFetch } from '@/hooks/use-api-fetch';

/**
 * Заработок гида.
 *
 * Честный минимум (решение владельца): нет начислений — так и сказано, а не
 * «0 ₽»; не загрузилось — ошибка, а не пустой список. Писателя начислений
 * гиду в платформе пока нет (lib/auth/guide-helpers.ts): он появится вместе с
 * назначением гида на оплаченную бронь.
 */

interface EarningsSummary {
  count: number;
  totalEarnings: number | null;
  paid: number | null;
  pendingPayment: number | null;
  toursWithEarnings: number | null;
  averagePerItem: number | null;
}

type EarningStatus = 'paid' | 'pending' | 'cancelled' | 'unknown';

interface EarningsItem {
  id: string;
  amount: number;
  status: EarningStatus;
  date: string;
  paymentDate: string | null;
  tourName: string | null;
  tourDate: string | null;
  notes: string | null;
}

interface EarningsData {
  summary: EarningsSummary;
  items: EarningsItem[];
}

const SELECT = 'px-3.5 py-2.5 text-sm bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors';

const STATUS_VIEW: Record<EarningStatus, { label: string; color: string }> = {
  paid: { label: 'Выплачено', color: 'var(--success)' },
  pending: { label: 'Ожидает выплаты', color: 'var(--warning)' },
  cancelled: { label: 'Отменено', color: 'var(--text-muted)' },
  unknown: { label: 'Статус не записан', color: 'var(--text-muted)' },
};

const rub = (v: number | null): string => (v === null ? '—' : `${v.toLocaleString('ru-RU')} ₽`);

function fmtDate(iso: string | null): string {
  if (!iso) return 'дата не записана';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? 'дата не записана' : d.toLocaleDateString('ru-RU');
}

/** CSV из того, что уже на экране: ни одной цифры сверх полученного от API. */
function exportCsv(items: EarningsItem[], period: string) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    ['Дата', 'Тур', 'Сумма, руб', 'Статус', 'Дата выплаты'].map(esc).join(';'),
    ...items.map((i) => [
      i.date, i.tourName ?? '', String(i.amount), STATUS_VIEW[i.status].label, i.paymentDate ?? '',
    ].map(esc).join(';')),
  ];
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nachisleniya-${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

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

  const { data, loading, error } = useApiFetch<EarningsData>(
    `/api/guide/earnings?period=${period}`,
    undefined,
    { errorMessage: 'Не удалось загрузить начисления. Попробуйте обновить страницу.' },
  );

  const summary = data?.summary ?? null;
  const items = data?.items ?? [];
  const empty = summary !== null && summary.count === 0 && items.length === 0;

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="ds-h1 flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-[var(--ocean)]" />
            Заработок
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">Начисления за проведённые туры</p>
        </div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className={SELECT} aria-label="Период">
          <option value="week">Неделя</option>
          <option value="month">Месяц</option>
          <option value="year">Год</option>
          <option value="all">Всё время</option>
        </select>
      </div>

      {loading ? (
        <LoadingSpinner message="Загрузка данных..." />
      ) : error || !summary ? (
        <div className="flex items-start gap-2 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 text-sm text-[var(--text-primary)]">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] flex-shrink-0" />
          <span>{error || 'Не удалось загрузить начисления.'}</span>
        </div>
      ) : empty ? (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-8 flex items-start gap-3">
          <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10 shrink-0">
            <Info className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />
          </span>
          <div className="text-sm text-[var(--text-secondary)]">
            <p className="font-semibold text-[var(--text-primary)]">Начислений пока нет</p>
            <p className="mt-1">
              {period === 'all'
                ? 'Начисления гидам появятся, когда оператор назначит вас на оплаченную бронь и тур будет проведён.'
                : 'За выбранный период начислений нет. Попробуйте период «Всё время».'}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Wallet} value={rub(summary.totalEarnings)} label="Начислено (без отменённых)" valueColor="var(--success)" />
            <StatCard icon={CreditCard} value={rub(summary.pendingPayment)} label="Ожидает выплаты" valueColor="var(--warning)" />
            <StatCard icon={Calendar} value={summary.toursWithEarnings === null ? '—' : String(summary.toursWithEarnings)} label="Туров с начислениями (из расписания)" valueColor="var(--accent)" />
            <StatCard icon={TrendingUp} value={rub(summary.averagePerItem)} label="Среднее начисление" />
          </div>

          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">История начислений</h2>
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={() => exportCsv(items, period)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors text-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  Экспорт CSV
                </button>
              )}
            </div>

            <div className="divide-y divide-[var(--border)]">
              {items.map((item) => {
                const view = STATUS_VIEW[item.status];
                return (
                  <div key={item.id} className="px-5 py-4 flex items-center justify-between hover:bg-[var(--bg-hover)] transition-colors">
                    <div>
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        {item.tourName ?? 'Тур не указан'}
                      </div>
                      <div className="text-xs text-[var(--text-muted)] mt-0.5">{fmtDate(item.date)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold" style={{ color: view.color }}>
                        {item.amount.toLocaleString('ru-RU')} ₽
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">{view.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
