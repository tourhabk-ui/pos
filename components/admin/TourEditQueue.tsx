'use client';

import { useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import type { PendingTourEdit } from '@/lib/tours/moderation';
import { TourEditDiff, TourEditValue } from '@/components/tours/TourEditDiff';

/** Карточка очереди — то, что отдаёт GET /api/admin/moderation/tour-edits. */
export type TourEditCard = PendingTourEdit;

interface Props {
  loading: boolean;
  error: string;
  edits: TourEditCard[];
  actingId: string | null;
  actionError: string;
  onRetry: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU');
}

const OWNER_WORD: Record<string, string> = { operator: 'Туроператор', guide: 'Гид' };

/**
 * Очередь туров и правок туров (миграция 1507; план готовности 23.11, этап 4).
 *
 * На сайте этого ещё нет: у правки карточка показывает, что на витрине сейчас
 * и что станет; у нового тура — всё содержание, которое выйдет на сайт.
 * Одобряется ровно показанное: отпечаток карточки едет вместе с решением.
 */
export function TourEditQueue({ loading, error, edits, actingId, actionError, onRetry, onApprove, onReject }: Props) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'all' | 'publish' | 'edit'>('all');
  const shown = filter === 'all' ? edits : edits.filter((e) => e.kind === filter);
  const count = (kind: 'publish' | 'edit') => edits.filter((e) => e.kind === kind).length;
  const FILTERS: Array<{ key: 'all' | 'publish' | 'edit'; label: string }> = [
    { key: 'all', label: `Все: ${edits.length}` },
    { key: 'publish', label: `Новые туры: ${count('publish')}` },
    { key: 'edit', label: `Правки: ${count('edit')}` },
  ];

  return (
    <section className="mb-8" aria-labelledby="tour-edits-heading">
      <h2 id="tour-edits-heading" className="text-lg font-bold text-[var(--text-primary)] mb-1">
        Туры и правки туров
      </h2>
      <p className="text-sm text-[var(--text-muted)] mb-3">
        Новый тур выходит на сайт только после одобрения. У тура, который уже на сайте, туристы видят прежнюю версию,
        пока правку названия, текстов, цены или снимков не одобрят. Скрыть тур и поменять даты владелец может сам, без очереди.
      </p>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center py-8 gap-3">
          <AlertCircle className="w-7 h-7 text-[var(--danger)]" />
          <p className="text-[var(--text-secondary)] text-sm">Не смог загрузить правки туров. {error}</p>
          <button type="button" onClick={onRetry} className="text-sm text-[var(--accent)] underline">Повторить</button>
        </div>
      ) : edits.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)] py-4">Туров и правок на проверке нет.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Что показать">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`min-h-[44px] px-3 py-2 rounded-lg border text-sm transition-colors duration-200 ${filter === f.key
                  ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--bg-hover)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {actionError && <p className="text-sm text-[var(--danger)]" role="alert">{actionError}</p>}
          {shown.length === 0 && <p className="text-sm text-[var(--text-secondary)] py-2">В этом разделе пусто.</p>}
          {shown.map((edit) => {
            const reason = reasons[edit.id] ?? '';
            const busy = actingId === edit.id;
            const reasonOk = reason.trim().length >= 5;
            const isNew = edit.kind === 'publish';
            const owner = OWNER_WORD[edit.partnerCategory ?? ''] ?? 'Партнёр';
            return (
              <article
                key={edit.id}
                className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4"
                data-testid="tour-edit"
                aria-label={`${isNew ? 'Новый тур' : 'Правка тура'}: ${edit.tourTitle}`}
              >
                <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                  {isNew ? 'Новый тур просится на сайт' : 'Правка тура на сайте'}
                </p>
                <p className="font-medium text-[var(--text-primary)]">{edit.tourTitle}</p>
                <p className="text-sm text-[var(--text-secondary)]">{owner}: {edit.partnerName}</p>
                <p className="text-xs text-[var(--text-muted)] mb-3">
                  {when(edit.since)}
                  {!isNew && (
                    <>
                      {' · '}
                      <a href={`/catalog/tours/${edit.tourId}`} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] underline">
                        как на сайте сейчас
                      </a>
                    </>
                  )}
                </p>

                {isNew ? (
                  <dl className="space-y-3 mb-3">
                    {edit.content.map((line) => (
                      <div key={line.field}>
                        <dt className="text-xs text-[var(--text-muted)]">{line.label}</dt>
                        <dd><TourEditValue text={line.text} photos={line.photos} label={line.label} /></dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <div className="mb-3"><TourEditDiff changes={edit.changes} /></div>
                )}

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
                      {isNew ? 'Опубликовать' : 'Одобрить'}
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
                  <p className="text-xs text-[var(--text-muted)] mt-1">Чтобы отклонить, напишите причину — хотя бы 5 знаков. Владелец тура её увидит.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
