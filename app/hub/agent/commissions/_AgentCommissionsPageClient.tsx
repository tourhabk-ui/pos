'use client';

import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Loader2, AlertTriangle, Send, Clock, ShieldCheck } from 'lucide-react';

/**
 * Вознаграждение агента (GET /api/agent/commissions) и заявка на выплату
 * (POST /api/agent/commissions/request-payout).
 *
 * Всё считает единственная функция денег агента: продажа — бронь оператора,
 * засчитанная агенту; начисляется с оплаченной и не отменённой; к выплате —
 * после конца тура + 36 часов. Ставку назначает владелец; пока её нет, суммы
 * приходят null, и экран говорит «ставка не назначена», а не «0 ₽».
 *
 * Прежде экран подставлял нули при любом отказе (EMPTY_STATS) — отказ
 * выглядел как «ничего не заработано», — а кнопки выплаты не было вовсе.
 */

type SaleState = 'cancelled' | 'unpaid' | 'waiting' | 'payable' | 'requested' | 'paid_out';

interface Sale {
  bookingId: string;
  bookingDate: string | null;
  tourTitle: string | null;
  saleAmount: number | null;
  releaseAfter: string | null;
  state: SaleState;
  rate: number | null;
  amount: number | null;
  flag: 'cancelled_in_request' | 'cancelled_after_payout' | null;
}

interface Summary {
  rate: number | null;
  waiting: number | null;
  payable: number | null;
  requested: number;
  paidOut: number;
  flagged: number;
  withoutPrice: number;
}

interface Payout {
  id: string;
  total_amount: string;
  status: string;
  created_at: string;
  paid_at: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  items: number;
}

interface CommissionsData {
  rate: number | null;
  profileStatus: string | null;
  summary: Summary;
  sales: Sale[];
  payouts: Payout[];
}

const STATE_LABEL: Record<SaleState, { label: string; cls: string }> = {
  cancelled: { label: 'Отменена', cls: 'text-[var(--text-muted)]' },
  unpaid:    { label: 'Не оплачена', cls: 'text-[var(--text-secondary)]' },
  waiting:   { label: 'Ждёт конца тура', cls: 'text-[var(--warning)]' },
  payable:   { label: 'Можно запросить', cls: 'text-[var(--success)]' },
  requested: { label: 'В заявке', cls: 'text-[var(--ocean)]' },
  paid_out:  { label: 'Выплачено', cls: 'text-[var(--success)]' },
};

const PAYOUT_LABEL: Record<string, string> = {
  pending: 'На рассмотрении',
  paid: 'Выплачено',
  rejected: 'Отклонена',
};

function rub(v: number): string {
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

function day(d: string | null): string {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('ru-RU');
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      <div className={`text-xl font-bold ${tone}`}>{value}</div>
      <div className="text-[var(--text-muted)] text-sm mt-1">{label}</div>
    </div>
  );
}

export default function AgentCommissionsPageClient() {
  const [data, setData] = useState<CommissionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestDone, setRequestDone] = useState<string | null>(null);

  // Состояние меняется только в ответе запроса: синхронный setState в
  // эффекте даёт лишний проход рендера. Повтор выставляет «загрузку» сам.
  const load = useCallback(() => {
    fetch('/api/agent/commissions')
      .then(async (r) => {
        const json = await r.json().catch(() => null) as { success?: boolean; error?: string; data?: CommissionsData } | null;
        if (r.ok && json?.success && json.data) { setData(json.data); setError(null); }
        else setError(json?.error ?? 'Вознаграждение не загружено');
      })
      .catch(() => setError('Сеть недоступна — вознаграждение не загружено'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    load();
  }, [load]);

  async function requestPayout() {
    setRequesting(true);
    setRequestError(null);
    setRequestDone(null);
    try {
      const res = await fetch('/api/agent/commissions/request-payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethod: 'bank_transfer' }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string; data?: { totalAmount: number } } | null;
      if (!res.ok || !json?.success) {
        setRequestError(json?.error ?? 'Заявка не отправлена');
        return;
      }
      setRequestDone(`Заявка на ${rub(json.data?.totalAmount ?? 0)} отправлена администратору`);
      setConfirming(false);
      reload();
    } catch {
      setRequestError('Сеть недоступна — заявка не отправлена');
    } finally {
      setRequesting(false);
    }
  }

  if (loading && !data) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" /></div>;
  }

  if (error || !data) {
    return (
      <div className="p-5 lg:p-6">
        <div role="alert" className="flex items-start gap-3 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--bg-card)] text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] shrink-0" />
          <div>
            <p className="text-[var(--text-primary)]">{error ?? 'Вознаграждение не загружено'}</p>
            <button type="button" onClick={reload} className="ds-btn ds-btn-secondary text-xs mt-3">Повторить</button>
          </div>
        </div>
      </div>
    );
  }

  const s = data.summary;
  const approved = data.profileStatus === 'approved';
  const openPayout = data.payouts.find((p) => p.status === 'pending') ?? null;
  const canRequest = approved && s.rate !== null && (s.payable ?? 0) > 0 && openPayout === null;

  let blockedReason: string | null = null;
  if (!approved) blockedReason = 'Кабинет агента откроется после одобрения администратором. Заполните профиль — он уйдёт на проверку.';
  else if (s.rate === null) blockedReason = 'Ставка вознаграждения ещё не назначена — её назначает владелец платформы.';
  else if (openPayout) blockedReason = 'Заявка на выплату уже на рассмотрении — дождитесь решения администратора.';
  else if ((s.payable ?? 0) <= 0) blockedReason = 'Сейчас запросить нечего: к выплате идут оплаченные продажи через 36 часов после окончания тура.';

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="ds-h1 flex items-center gap-2">
          <CreditCard className="w-6 h-6 text-[var(--ocean)]" />
          Вознаграждение
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          {s.rate === null ? 'Ставка не назначена' : `Ставка: ${s.rate}% от оплаченной продажи`}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Можно запросить" tone="text-[var(--success)]"
          value={s.payable === null ? 'ставка не назначена' : rub(s.payable)} />
        <StatCard label="Ждёт конца тура" tone="text-[var(--warning)]"
          value={s.waiting === null ? 'ставка не назначена' : rub(s.waiting)} />
        <StatCard label="В заявке" tone="text-[var(--ocean)]" value={rub(s.requested)} />
        <StatCard label="Выплачено" tone="text-[var(--text-primary)]" value={rub(s.paidOut)} />
      </div>

      {s.withoutPrice > 0 && (
        <p className="text-xs text-[var(--text-secondary)]">
          У {s.withoutPrice} оплаченных продаж не записана сумма брони — посчитать вознаграждение по ним нельзя.
        </p>
      )}
      {s.flagged > 0 && (
        <p className="text-xs text-[var(--warning)]">
          {s.flagged} продаж отменены после заявки или выплаты — администратор разберёт их вручную.
        </p>
      )}

      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-3">
        <div className="flex items-start gap-3">
          <span className="flex items-center justify-center w-9 h-9 rounded-full bg-[var(--ocean)]/10 shrink-0">
            {approved ? <ShieldCheck className="w-[18px] h-[18px] text-[var(--success)]" /> : <Clock className="w-[18px] h-[18px] text-[var(--ocean)]" />}
          </span>
          <div className="text-sm min-w-0">
            <p className="font-semibold text-[var(--text-primary)]">Выплата</p>
            <p className="text-[var(--text-secondary)] mt-1">
              Деньги переводит администратор вне платформы и отмечает перевод здесь. В заявку войдут все продажи «можно запросить».
            </p>
            {blockedReason && <p className="text-[var(--text-secondary)] mt-1">{blockedReason}</p>}
          </div>
        </div>
        {requestError && (
          <p role="alert" className="text-sm text-[var(--danger)]">{requestError}</p>
        )}
        {requestDone && <p className="text-sm text-[var(--success)]">{requestDone}</p>}
        {canRequest && !confirming && (
          <button type="button" onClick={() => setConfirming(true)} className="ds-btn ds-btn-primary text-sm">
            <Send className="w-4 h-4" /> Запросить выплату {rub(s.payable ?? 0)}
          </button>
        )}
        {canRequest && confirming && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-[var(--text-primary)]">Отправить заявку на {rub(s.payable ?? 0)}?</span>
            <button type="button" onClick={() => void requestPayout()} disabled={requesting} className="ds-btn ds-btn-primary text-sm">
              {requesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Отправить
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={requesting} className="ds-btn ds-btn-secondary text-sm">
              Отмена
            </button>
          </div>
        )}
      </section>

      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
        <h2 className="px-4 py-3 border-b border-[var(--border)] text-sm font-semibold text-[var(--text-primary)]">Продажи</h2>
        {data.sales.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[var(--text-muted)]">Продаж пока нет: брони по вашей ссылке и оформленные за клиента появятся здесь.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="px-4 py-2 font-medium">Тур</th>
                  <th className="px-4 py-2 font-medium">Дата</th>
                  <th className="px-4 py-2 font-medium">Продажа</th>
                  <th className="px-4 py-2 font-medium">Вознаграждение</th>
                  <th className="px-4 py-2 font-medium">Состояние</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {data.sales.map((sale) => (
                  <tr key={sale.bookingId}>
                    <td className="px-4 py-2 text-[var(--text-primary)]">{sale.tourTitle ?? `Бронь ${sale.bookingId}`}</td>
                    <td className="px-4 py-2 text-[var(--text-secondary)]">{day(sale.bookingDate)}</td>
                    <td className="px-4 py-2 text-[var(--text-secondary)]">{sale.saleAmount === null ? '—' : rub(sale.saleAmount)}</td>
                    <td className="px-4 py-2 text-[var(--text-primary)]">{sale.amount === null ? '—' : rub(sale.amount)}</td>
                    <td className={`px-4 py-2 ${STATE_LABEL[sale.state].cls}`}>
                      {STATE_LABEL[sale.state].label}
                      {sale.state === 'waiting' && sale.releaseAfter && (
                        <span className="block text-xs text-[var(--text-muted)]">с {day(sale.releaseAfter)}</span>
                      )}
                      {sale.flag && <span className="block text-xs text-[var(--warning)]">бронь отменена</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.payouts.length > 0 && (
        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <h2 className="px-4 py-3 border-b border-[var(--border)] text-sm font-semibold text-[var(--text-primary)]">Заявки на выплату</h2>
          <ul className="divide-y divide-[var(--border)]">
            {data.payouts.map((p) => (
              <li key={p.id} className="px-4 py-3 text-sm flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-[var(--text-primary)] font-medium">{rub(Number(p.total_amount))} · {p.items} продаж</p>
                  <p className="text-xs text-[var(--text-muted)]">от {day(p.created_at)}{p.paid_at ? `, выплачено ${day(p.paid_at)}` : ''}</p>
                  {p.status === 'rejected' && p.reject_reason && (
                    <p className="text-xs text-[var(--text-secondary)] mt-1">Причина: {p.reject_reason}</p>
                  )}
                </div>
                <span className="ds-badge border border-[var(--border)] text-[var(--text-secondary)]">{PAYOUT_LABEL[p.status] ?? p.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
