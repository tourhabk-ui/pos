'use client';

/**
 * Отказ по заявке оператора: причина и повторная подача (слово владельца
 * 23.11: «отклонённый оператор видит причину отказа и может подать заявку
 * снова, как у гида»).
 *
 * До этого дня причина приходила в ответе профиля и не показывалась нигде,
 * а дверь подачи работала только из «не подана»: отклонённый оператор читал
 * «свяжитесь с администратором платформы» и упирался в стену.
 *
 * Блок рисуется только у отклонённой заявки. Подаёт владелец кабинета;
 * менеджеру компании сказано, кто может. Причины могло не быть — так и
 * сказано, а не пустая строка (§4.0).
 */

import { useState } from 'react';
import { AlertCircle, Loader2, Send } from 'lucide-react';

export interface ProfileReviewNoticeProps {
  status: string | null;
  /** Комментарий администратора к отказу; null — не записан. */
  comment: string | null;
  /** Кто смотрит: подать снова может только владелец кабинета. */
  viewer: 'owner' | 'manager';
  /** Заявка ушла на проверку: экран обновляет статус у себя. */
  onResubmitted: () => void;
}

export function ProfileReviewNotice({ status, comment, viewer, onResubmitted }: ProfileReviewNoticeProps) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  if (sent) {
    return (
      <section role="status" data-testid="profile-review" data-state="resubmitted"
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm text-[var(--text-primary)]">
        {sent}
      </section>
    );
  }
  if (status !== 'rejected') return null;

  const reason = comment?.trim() ? comment.trim() : null;

  async function resubmit() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/hub/operator/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submit_for_review: true }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; message?: string; error?: string } | null;
      if (res.ok && json?.success) {
        setSent(json.message ?? 'Заявка отправлена на проверку снова.');
        onResubmitted();
      } else {
        setError(json?.error ?? 'Не удалось отправить заявку. Попробуйте позже.');
      }
    } catch {
      setError('Не удалось отправить заявку. Проверьте соединение.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section data-testid="profile-review" data-state="rejected"
      className="rounded-lg border border-[var(--danger)] bg-[var(--bg-card)] p-4 space-y-2 text-sm">
      <p className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
        <AlertCircle className="w-4 h-4 text-[var(--danger)]" aria-hidden /> Заявка отклонена
      </p>
      <p className="text-[var(--text-secondary)]" data-testid="profile-review-reason">
        {reason ? <>Причина отказа: {reason}</> : 'Причина отказа не записана.'}
      </p>
      {viewer === 'owner' ? (
        <>
          <p className="text-[var(--text-secondary)]">
            Исправьте профиль и сохраните изменения: на проверку уйдёт сохранённая версия.
          </p>
          <button type="button" onClick={() => { void resubmit(); }} disabled={sending}
            className="ds-btn ds-btn-primary flex items-center gap-2 min-h-[44px] px-4">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Send className="w-4 h-4" aria-hidden />}
            Отправить на проверку снова
          </button>
          {error && <p role="alert" className="text-[var(--danger)]">{error}</p>}
        </>
      ) : (
        <p className="text-[var(--text-secondary)]">Отправить заявку на проверку снова может владелец кабинета.</p>
      )}
    </section>
  );
}
