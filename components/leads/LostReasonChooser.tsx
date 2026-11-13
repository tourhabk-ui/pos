'use client';

/**
 * Выбор причины отказа по заявке (план «после отказа», этап 3а).
 *
 * Один на кабинет оператора и раздел «Свои туры» гида. До выбора продавец
 * видит, что получит турист: после отказа продавца ему уходит сообщение
 * Ведара, после причины на стороне клиента — ничего. Нажатие причины и есть
 * отметка «Отказ»: отдельной кнопки «Да» нет, поэтому последствие названо
 * над кнопками, а не после них.
 */
import { Loader2 } from 'lucide-react';
import { LOST_REASON_GROUPS, LOST_REASON_LABEL, type LostReason } from '@/lib/leads/lost-reason';

export function LostReasonChooser({ busy, onChoose, onCancel }: {
  busy: boolean;
  onChoose: (reason: LostReason) => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-3" data-testid="lost-reason-chooser">
      <p className="text-sm font-medium text-[var(--text-primary)]">Почему закрываете заявку?</p>
      {LOST_REASON_GROUPS.map((group) => (
        <div key={group.key} role="group" aria-label={group.title} className="space-y-2">
          <p className="text-sm text-[var(--text-primary)]">{group.title}</p>
          <p className="text-sm text-[var(--text-secondary)]">{group.note}</p>
          <div className="flex flex-wrap gap-2">
            {group.reasons.map((reason) => (
              <button
                key={reason}
                type="button"
                className="ds-btn ds-btn-secondary"
                disabled={busy}
                onClick={() => onChoose(reason)}
              >
                {LOST_REASON_LABEL[reason]}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="ds-btn ds-btn-secondary" disabled={busy} onClick={onCancel}>Назад</button>
        {busy && (
          <span className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)]" role="status">
            <Loader2 size={14} className="animate-spin" /> Записываю
          </span>
        )}
      </div>
    </div>
  );
}
