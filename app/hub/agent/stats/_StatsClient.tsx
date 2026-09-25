'use client';

import { useCallback, useEffect, useState } from 'react';
import { Protected } from '@/components/auth/Protected';
import { TrendingUp, Loader2, Users, Repeat, Wallet, AlertTriangle } from 'lucide-react';

/**
 * Статистика агента (GET /api/agent/stats). Начисления — из единственной
 * функции денег агента: оплаченные и не отменённые продажи по ставке, которую
 * назначил владелец. Прежде при отказе запроса экран молча оставлял нули и
 * показывал «0K ₽» и «0%» — отказ выглядел как «ничего не заработано».
 * Теперь отказ — сообщение с кнопкой повтора, а отсутствие числа (нет ставки,
 * нет клиентов) — словами.
 */

interface MonthCommission { month: string; amount: number | null }

interface StatsData {
  rate: number | null;
  commissions: MonthCommission[];
  clients: number;
  retention: number | null;
  repeatClients: number;
  topTours: Array<{ name: string; bookings: number }>;
}

function rub(v: number): string {
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
}

function monthLabel(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? ym : d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' });
}

export default function StatsClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StatsData | null>(null);

  const load = useCallback(() => {
    fetch('/api/agent/stats')
      .then(async (r) => {
        const json = await r.json().catch(() => null) as { success?: boolean; error?: string; data?: StatsData } | null;
        if (r.ok && json?.success && json.data) { setData(json.data); setError(null); }
        else setError(json?.error ?? 'Статистика не загружена');
      })
      .catch(() => setError('Сеть недоступна — статистика не загружена'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    load();
  }, [load]);

  const amounts = (data?.commissions ?? []).map((c) => c.amount ?? 0);
  const totalEarned = data?.rate === null ? null : amounts.reduce((s, a) => s + a, 0);
  const maxAmount = Math.max(...amounts, 1);

  return (
    <Protected roles={['agent', 'admin']}>
      <div className="max-w-5xl mx-auto p-6">
        <h1 className="ds-h1 flex items-center gap-2 mb-6">
          <TrendingUp className="w-6 h-6 text-[var(--ocean)]" />
          Статистика
        </h1>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>
        ) : error || !data ? (
          <div role="alert" className="flex items-start gap-3 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--bg-card)] text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] shrink-0" />
            <div>
              <p className="text-[var(--text-primary)]">{error ?? 'Статистика не загружена'}</p>
              <button type="button" onClick={reload} className="ds-btn ds-btn-secondary text-xs mt-3">Повторить</button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
                <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1"><Wallet className="w-4 h-4" /> Начислено</div>
                <p className="text-2xl font-bold text-[var(--text-primary)]">
                  {totalEarned === null ? 'ставка не назначена' : rub(totalEarned)}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">оплаченные и не отменённые продажи</p>
              </div>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
                <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1"><Repeat className="w-4 h-4" /> Удержание клиентов</div>
                <p className="text-2xl font-bold text-[var(--text-primary)]">
                  {data.retention === null ? 'нет клиентов' : `${data.retention}%`}
                </p>
              </div>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
                <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm mb-1"><Users className="w-4 h-4" /> Повторные клиенты</div>
                <p className="text-2xl font-bold text-[var(--text-primary)]">{data.repeatClients} из {data.clients}</p>
              </div>
            </div>

            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2"><TrendingUp className="w-5 h-5" /> Начисления по месяцам тура</h2>
              {data.commissions.length === 0 ? (
                <p className="text-[var(--text-muted)] text-sm">Оплаченных продаж пока нет</p>
              ) : data.rate === null ? (
                <p className="text-[var(--text-muted)] text-sm">Ставка вознаграждения не назначена — начисления не считаются.</p>
              ) : (
                <div className="flex items-end gap-3 h-32">
                  {data.commissions.map((c) => (
                    <div key={c.month} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                      <span className="text-xs text-[var(--text-muted)]">{rub(c.amount ?? 0)}</span>
                      <div className="w-full bg-[var(--accent)] rounded-t-md" style={{ height: `${((c.amount ?? 0) / maxAmount) * 100}%` }} />
                      <span className="text-xs text-[var(--text-secondary)]">{monthLabel(c.month)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5">
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Лучшие туры</h2>
              {data.topTours.length === 0 ? (
                <p className="text-[var(--text-muted)] text-sm">Оплаченных продаж пока нет</p>
              ) : (
                <div className="space-y-3">
                  {data.topTours.map((t, i) => (
                    <div key={t.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="w-6 h-6 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] flex items-center justify-center text-xs font-bold">{i + 1}</span>
                        <span className="text-[var(--text-primary)]">{t.name}</span>
                      </div>
                      <span className="text-sm text-[var(--text-secondary)]">{t.bookings} оплачено</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Protected>
  );
}
