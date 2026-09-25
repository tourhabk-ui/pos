'use client';

import { useCallback, useEffect, useState } from 'react';
import { User, ShieldCheck, Clock, Loader2, Send, AlertTriangle } from 'lucide-react';
import PartnerProfileEditor from '@/components/hub/PartnerProfileEditor';
import { profileStatusView } from '@/lib/operator/profile-status';

/**
 * Страница «Профиль» агентского кабинета — редактирование профиля/контактов
 * через общий PartnerProfileEditor (GET/PATCH /api/partners/profile).
 *
 * Сверху — статус проверки (решение владельца 26.09): агент работает только
 * после одобрения администратором. До одобрения кабинет и профиль открыты,
 * продажи и выплаты закрыты. Отклонённый профиль можно исправить и подать
 * снова (PATCH { submit_for_review: true }).
 */

interface ProfileStatus {
  profile_status: string;
  profile_review_comment: string | null;
}

export default function AgentProfileClient() {
  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/partners/profile')
      .then(async (r) => {
        const d = await r.json().catch(() => null) as { success?: boolean; data?: { partner?: ProfileStatus } } | null;
        if (r.ok && d?.data?.partner) { setStatus(d.data.partner); setFailed(false); }
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submitForReview() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/partners/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submit_for_review: true }),
      });
      const d = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!res.ok || !d?.success) { setSubmitError(d?.error ?? 'Заявку отправить не удалось'); return; }
      load();
    } catch {
      setSubmitError('Сеть недоступна — заявка не отправлена');
    } finally {
      setSubmitting(false);
    }
  }

  const st = status?.profile_status ?? null;
  const view = st ? profileStatusView(st) : null;

  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <User className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Профиль агентства</h1>
      </div>

      {failed && (
        <div role="alert" className="flex items-start gap-2 p-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--bg-card)] text-sm text-[var(--text-primary)]">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--danger)] shrink-0" />
          <span>Статус проверки не загружен. <button type="button" onClick={load} className="underline">Повторить</button></span>
        </div>
      )}

      {st && view && (
        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-5 flex items-start gap-3">
          <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ocean)]/10 shrink-0">
            {st === 'approved'
              ? <ShieldCheck className="w-[22px] h-[22px] text-[var(--success)]" strokeWidth={1.75} />
              : <Clock className="w-[22px] h-[22px] text-[var(--ocean)]" strokeWidth={1.75} />}
          </span>
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-[var(--text-primary)]">
              Проверка платформой: <span className={view.color}>{view.label}</span>
            </p>
            <p className="text-[var(--text-secondary)] mt-1">
              {st === 'approved' && 'Кабинет открыт: можно продавать туры и запрашивать выплату вознаграждения.'}
              {st === 'pending' && 'Администратор проверяет профиль. До одобрения продажи и выплаты закрыты.'}
              {st === 'none' && 'Заполните профиль и отправьте его на проверку. Агент работает после одобрения администратором.'}
              {st === 'rejected' && 'Профиль не прошёл проверку. Исправьте его и отправьте снова.'}
            </p>
            {st === 'rejected' && status?.profile_review_comment && (
              <p className="text-[var(--text-secondary)] mt-1">Причина отказа: {status.profile_review_comment}</p>
            )}
            {submitError && <p role="alert" className="text-[var(--danger)] mt-2">{submitError}</p>}
            {(st === 'none' || st === 'rejected') && (
              <button type="button" onClick={() => void submitForReview()} disabled={submitting}
                className="ds-btn ds-btn-primary text-sm mt-3">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {st === 'rejected' ? 'Отправить на проверку снова' : 'Отправить на проверку'}
              </button>
            )}
          </div>
        </section>
      )}

      <PartnerProfileEditor namePlaceholder="Турагентство «Восток»" />
    </div>
  );
}
