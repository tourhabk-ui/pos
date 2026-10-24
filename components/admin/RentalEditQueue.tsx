'use client';

import { useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { formatRub } from '@/lib/transfers/charter-format';

export interface RentalEditCard {
  id: string;
  partnerName: string;
  title: string;
  livePrice: number;
  priceIsFrom: boolean;
  liveConditions: string | null;
  draftPrice: number | null;
  draftConditions: string | null;
  createdAt: string;
}

interface RentalEditQueueProps {
  loading: boolean;
  error: string;
  edits: RentalEditCard[];
  actingId: string | null;
  actionError: string;
  onRetry: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU');
}

/**
 * Очередь черновиков цены и описания проката. На сайте этих строк ещё нет:
 * карточка показывает, что сейчас в прайсе и что просит прокатчик.
 */
export function RentalEditQueue({
  loading, error, edits, actingId, actionError, onRetry, onApprove, onReject,
}: RentalEditQueueProps) {
  const [reasons, setReasons] = useState<Record<string, string>>({});

  return (
    <section className="mb-8" aria-labelledby="rental-edits-heading">
      <h2 id="rental-edits-heading" className="text-lg font-bold text-[var(--text-primary)] mb-1">
        Правки прайса проката
      </h2>
      <p className="text-sm text-[var(--text-muted)] mb-3">
        Черновик цены или описания. На сайте остаётся текущая строка, пока правку не одобрят. Фото здесь не меняются.
      </p>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center py-8 gap-3">
          <AlertCircle className="w-7 h-7 text-[var(--danger)]" />
          <p className="text-[var(--text-secondary)] text-sm">Не смог загрузить правки прайса. {error}</p>
          <button type="button" onClick={onRetry} className="text-sm text-[var(--accent)] underline">Повторить</button>
        </div>
      ) : edits.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)] py-4">Правок прайса проката нет.</p>
      ) : (
        <div className="space-y-3">
          {actionError && (
            <p className="text-sm text-[var(--danger)]" role="alert">{actionError}</p>
          )}
          {edits.map((edit) => {
            const reason = reasons[edit.id] ?? '';
            const busy = actingId === edit.id;
            const reasonOk = reason.trim().length >= 5;
            return (
              <article key={edit.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
                <p className="font-medium text-[var(--text-primary)]">{edit.partnerName}</p>
                <p className="text-sm text-[var(--text-secondary)]">{edit.title}</p>
                <p className="text-xs text-[var(--text-muted)] mb-3">{when(edit.createdAt)}</p>
                <dl className="text-sm space-y-2 mb-3">
                  <div>
                    <dt className="text-[var(--text-muted)]">Цена за сутки</dt>
                    <dd className="text-[var(--text-primary)]">
                      {edit.draftPrice === null
                        ? 'черновик цену не меняет'
                        : `${formatRub(edit.livePrice)}${edit.priceIsFrom ? ' (в прайсе «от»)' : ''} → ${formatRub(edit.draftPrice)}`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--text-muted)]">Описание</dt>
                    <dd className="text-[var(--text-primary)] whitespace-pre-wrap">
                      {edit.draftConditions === null
                        ? 'черновик описание не меняет'
                        : edit.draftConditions}
                    </dd>
                    {edit.draftConditions !== null && (
                      <dd className="text-xs text-[var(--text-muted)] mt-1 whitespace-pre-wrap">
                        Сейчас на сайте: {edit.liveConditions && edit.liveConditions.trim().length > 0 ? edit.liveConditions : 'описания нет'}
                      </dd>
                    )}
                  </div>
                </dl>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="flex-1 text-xs text-[var(--text-muted)]">
                    Причина отказа
                    <textarea
                      value={reason}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [edit.id]: e.target.value }))}
                      rows={2}
                      maxLength={1000}
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    />
                  </label>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onApprove(edit.id)}
                      disabled={busy}
                      className="min-h-[44px] px-3 py-2 rounded-lg bg-[var(--success)] text-[var(--text-primary)] text-sm font-medium inline-flex items-center gap-1 hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      Одобрить
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject(edit.id, reason.trim())}
                      disabled={busy || !reasonOk}
                      className="min-h-[44px] px-3 py-2 rounded-lg bg-[var(--danger)] text-[var(--text-primary)] text-sm font-medium inline-flex items-center gap-1 hover:opacity-90 disabled:opacity-50"
                    >
                      <X className="w-4 h-4" />
                      Отклонить
                    </button>
                  </div>
                </div>
                {!reasonOk && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">Чтобы отклонить, напишите причину — хотя бы 5 знаков.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
