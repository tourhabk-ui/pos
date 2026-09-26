'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Check, X, Percent, Banknote } from 'lucide-react';
import { Sensitive } from '@/components/admin/shared/Sensitive';

/**
 * Агенты в финансах администратора (решение владельца 26.09).
 *
 * Две руки владельца и администратора, обе с обязательным основанием:
 *  - ставка агента — POST /api/admin/agent-commission/rate. Нет ставки — нет
 *    вознаграждения; автомат её не назначает;
 *  - заявки на выплату — GET/POST /api/admin/agent-commission/payouts.
 *    Деньги переводятся вне платформы; здесь отмечается факт с
 *    подтверждением перевода, как у возврата туристу.
 * Отдельным списком — выплаченные продажи, отменённые позже: минус агенту
 * молча не ставится, решение за человеком.
 */

interface AgentRow {
  partner_id: string;
  name: string;
  email: string;
  profile_status: string;
  rate: string | null;
  rate_set_at: string | null;
  rate_reason: string | null;
}

interface PayoutItem {
  booking_id: string;
  tour_title: string | null;
  booking_date: string | null;
  sale_amount: string;
  rate: string;
  amount: string;
  voided: boolean;
}

interface PayoutRow {
  id: string;
  agent_name: string;
  agent_email: string;
  total_amount: string;
  status: string;
  payment_method: string | null;
  notes: string | null;
  created_at: string;
  paid_at: string | null;
  paid_reason: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  items: PayoutItem[];
}

interface FlaggedRow {
  payout_id: string;
  agent_name: string;
  booking_id: string;
  amount: string;
  booking_status: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Ждёт решения',
  paid: 'Выплачено',
  rejected: 'Отклонена',
  none: 'Заявка не подана',
  approved: 'Одобрен',
};

function rub(v: string | number): string {
  return `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

function day(d: string | null): string {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('ru-RU');
}

async function readJson(res: Response): Promise<{ success?: boolean; error?: string; data?: unknown; bookings?: string[] } | null> {
  return res.json().catch(() => null) as Promise<{ success?: boolean; error?: string; data?: unknown; bookings?: string[] } | null>;
}

function RateEditor({ agent, onSaved }: { agent: AgentRow; onSaved: () => void }) {
  const [rate, setRate] = useState(agent.rate === null ? '' : String(Number(agent.rate)));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const value = rate.trim() === '' ? null : Number(rate.replace(',', '.'));
      if (value !== null && !Number.isFinite(value)) { setError('Ставка — число от 0 до 30 или пусто'); return; }
      const res = await fetch('/api/admin/agent-commission/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partnerId: agent.partner_id, rate: value, reason }),
      });
      const d = await readJson(res);
      if (!res.ok || !d?.success) { setError(d?.error ?? 'Ставка не сохранена'); return; }
      setReason('');
      onSaved();
    } catch {
      setError('Сеть недоступна — ставка не сохранена');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mt-2">
      <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="не назначена"
        inputMode="decimal" className="ds-input w-28 text-sm" aria-label="Ставка, %" />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Основание: договорённость, дата"
        className="ds-input flex-1 min-w-[200px] text-sm" aria-label="Основание" />
      <button type="button" onClick={() => void save()} disabled={saving || reason.trim().length < 8}
        className="ds-btn ds-btn-primary text-xs">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Сохранить
      </button>
      {error && <p role="alert" className="w-full text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}

function PayoutCard({ payout, onDone }: { payout: PayoutRow; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [acting, setActing] = useState<'mark_paid' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: 'mark_paid' | 'reject') {
    setActing(action);
    setError(null);
    try {
      const res = await fetch('/api/admin/agent-commission/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutId: payout.id, action, reason }),
      });
      const d = await readJson(res);
      if (!res.ok || !d?.success) {
        const extra = d?.bookings?.length ? ` Брони: ${d.bookings.join(', ')}.` : '';
        setError((d?.error ?? 'Не выполнено') + extra);
        return;
      }
      onDone();
    } catch {
      setError('Сеть недоступна — решение не записано');
    } finally {
      setActing(null);
    }
  }

  const voided = payout.items.filter((i) => i.voided).length;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="text-sm">
          <p className="font-semibold text-[var(--text-primary)]">
            <Sensitive>{payout.agent_name}</Sensitive> · {rub(payout.total_amount)}
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            <Sensitive>{payout.agent_email}</Sensitive> · заявка от {day(payout.created_at)} · {payout.items.length} продаж
          </p>
          {payout.notes && <p className="text-xs text-[var(--text-secondary)] mt-1">Комментарий агента: {payout.notes}</p>}
        </div>
        <span className="ds-badge border border-[var(--border)] text-[var(--text-secondary)]">{STATUS_LABEL[payout.status] ?? payout.status}</span>
      </div>

      <ul className="text-xs text-[var(--text-secondary)] space-y-1">
        {payout.items.map((i) => (
          <li key={i.booking_id} className={i.voided ? 'text-[var(--warning)]' : ''}>
            Бронь {i.booking_id} · {i.tour_title ?? 'тур'} · {day(i.booking_date)} · продажа {rub(i.sale_amount)} × {Number(i.rate)}% = {rub(i.amount)}
            {i.voided && ' · бронь отменена'}
          </li>
        ))}
      </ul>

      {payout.status === 'paid' && (
        <p className="text-xs text-[var(--text-secondary)]">Выплачено {day(payout.paid_at)}: {payout.paid_reason}</p>
      )}
      {payout.status === 'rejected' && (
        <p className="text-xs text-[var(--text-secondary)]">Отклонена {day(payout.rejected_at)}: {payout.reject_reason}</p>
      )}

      {payout.status === 'pending' && (
        <div className="space-y-2">
          {voided > 0 && (
            <p className="text-xs text-[var(--warning)]">
              {voided} брони отменены после заявки — отметить выплату нельзя. Отклоните заявку: агент запросит заново без них.
            </p>
          )}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
            placeholder="Для выплаты — подтверждение перевода (номер операции, скриншот); для отказа — причина"
            className="ds-input w-full text-sm resize-none" aria-label="Основание решения" />
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => void act('mark_paid')}
              disabled={acting !== null || reason.trim().length < 8 || voided > 0}
              className="ds-btn ds-btn-primary text-xs">
              {acting === 'mark_paid' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Отметить выплаченной
            </button>
            <button type="button" onClick={() => void act('reject')}
              disabled={acting !== null || reason.trim().length < 8}
              className="ds-btn ds-btn-secondary text-xs">
              {acting === 'reject' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />} Отклонить
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function AgentPayoutsPanel() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[] | null>(null);
  const [flagged, setFlagged] = useState<FlaggedRow[]>([]);
  const [status, setStatus] = useState<'pending' | 'paid' | 'rejected' | 'all'>('pending');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/admin/agent-commission/rate').then(readJson),
      fetch(`/api/admin/agent-commission/payouts?status=${status}`).then(readJson),
    ])
      .then(([a, p]) => {
        if (!a?.success || !p?.success) { setError(a?.error ?? p?.error ?? 'Данные агентов не загружены'); return; }
        setError(null);
        setAgents((a.data as { agents: AgentRow[] }).agents);
        const pd = p.data as { payouts: PayoutRow[]; cancelledAfterPayout: FlaggedRow[] };
        setPayouts(pd.payouts);
        setFlagged(pd.cancelledAfterPayout);
      })
      .catch(() => setError('Сеть недоступна — данные агентов не загружены'));
  }, [status]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div role="alert" className="flex items-start gap-3 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--bg-card)] text-sm">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] shrink-0" />
        <div>
          <p className="text-[var(--text-primary)]">{error}</p>
          <button type="button" onClick={load} className="ds-btn ds-btn-secondary text-xs mt-3">Повторить</button>
        </div>
      </div>
    );
  }

  if (agents === null || payouts === null) {
    return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Banknote className="w-4 h-4 text-[var(--ocean)]" /> Заявки агентов на выплату
        </h2>
        <div className="flex gap-1 flex-wrap">
          {(['pending', 'paid', 'rejected', 'all'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setStatus(s)}
              className={`px-3 py-1 text-xs rounded-md border transition-colors ${status === s
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}>
              {s === 'all' ? 'Все' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        {payouts.length === 0
          ? <p className="text-sm text-[var(--text-muted)]">Заявок нет.</p>
          : payouts.map((p) => <PayoutCard key={p.id} payout={p} onDone={load} />)}
      </section>

      {flagged.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--warning)] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Выплачено, а бронь потом отменена
          </h2>
          <p className="text-xs text-[var(--text-secondary)]">
            Вознаграждение уже переведено. Удержать его в следующей выплате или оставить — решение администратора; платформа агента в минус не уводит.
          </p>
          <ul className="text-xs text-[var(--text-secondary)] space-y-1">
            {flagged.map((f) => (
              <li key={`${f.payout_id}-${f.booking_id}`}>
                <Sensitive>{f.agent_name}</Sensitive> · бронь {f.booking_id} · {rub(f.amount)} · статус брони {f.booking_status}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Percent className="w-4 h-4 text-[var(--ocean)]" /> Ставки агентов
        </h2>
        <p className="text-xs text-[var(--text-secondary)]">
          Ставку назначает владелец. Пусто — «не назначена»: вознаграждение не начисляется. 0 — решение «без вознаграждения».
          Уже запрошенное и выплаченное смена ставки не меняет.
        </p>
        {agents.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Агентов пока нет.</p>
        ) : agents.map((a) => (
          <div key={a.partner_id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap text-sm">
              <div>
                <p className="font-medium text-[var(--text-primary)]">{a.name}</p>
                <p className="text-xs text-[var(--text-muted)]"><Sensitive>{a.email}</Sensitive> · {STATUS_LABEL[a.profile_status] ?? a.profile_status}</p>
              </div>
              <p className="text-sm text-[var(--text-primary)]">
                {a.rate === null ? 'ставка не назначена' : `${Number(a.rate)}%`}
                {a.rate_set_at && <span className="block text-xs text-[var(--text-muted)]">с {day(a.rate_set_at)}: {a.rate_reason}</span>}
              </p>
            </div>
            <RateEditor agent={a} onSaved={load} />
          </div>
        ))}
      </section>
    </div>
  );
}
