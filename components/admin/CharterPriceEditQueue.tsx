'use client';

import { useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { formatRub } from '@/lib/transfers/charter-format';
import { priceRowLabel, type CharterPriceRow, type SeenPriceDraft } from '@/lib/transfers/price-edit';

/** Карточка очереди — то, что отдаёт GET /api/admin/moderation/charter-price-edits. */
export interface CharterPriceEditCard {
  id: string;
  partnerName: string;
  priceId: string | null;
  live: CharterPriceRow | null;
  draft: SeenPriceDraft;
  createdAt: string;
}

interface Props {
  loading: boolean;
  error: string;
  edits: CharterPriceEditCard[];
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

function yesNo(v: boolean): string {
  return v ? 'показана' : 'скрыта';
}

/** Подпись черновика: у правки — живая строка, у новой — из полей черновика. */
export function editCardLabel(edit: Pick<CharterPriceEditCard, 'live' | 'draft'>): string {
  if (edit.live) return priceRowLabel(edit.live);
  const d = edit.draft;
  return priceRowLabel({
    lineKind: (d.lineKind ?? 'destination') as CharterPriceRow['lineKind'],
    fromText: d.fromText,
    toText: d.toText,
    vehicleKind: (d.vehicleKind ?? 'other') as CharterPriceRow['vehicleKind'],
  });
}

/**
 * Очередь черновиков прайса перевозчиков (1355). На сайте этих строк ещё нет:
 * карточка показывает, что сейчас в прайсе и что просит перевозчик. Новая
 * строка — целиком; правка — только поля, которые меняются.
 */
export function CharterPriceEditQueue({ loading, error, edits, actingId, actionError, onRetry, onApprove, onReject }: Props) {
  const [reasons, setReasons] = useState<Record<string, string>>({});

  return (
    <section className="mb-8" aria-labelledby="charter-price-edits-heading">
      <h2 id="charter-price-edits-heading" className="text-lg font-bold text-[var(--text-primary)] mb-1">
        Правки прайса перевозчиков
      </h2>
      <p className="text-sm text-[var(--text-muted)] mb-3">
        Черновик цены, примечания, условий, видимости или новая строка. На сайте остаётся текущий прайс, пока правку не одобрят.
        Одобрение новой строки вставляет её в прайс; дубль направления база отвергнет.
      </p>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center py-8 gap-3">
          <AlertCircle className="w-7 h-7 text-[var(--danger)]" />
          <p className="text-[var(--text-secondary)] text-sm">Не смог загрузить правки прайса перевозчиков. {error}</p>
          <button type="button" onClick={onRetry} className="text-sm text-[var(--accent)] underline">Повторить</button>
        </div>
      ) : edits.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)] py-4">Правок прайса перевозчиков нет.</p>
      ) : (
        <div className="space-y-3">
          {actionError && <p className="text-sm text-[var(--danger)]" role="alert">{actionError}</p>}
          {edits.map((edit) => {
            const reason = reasons[edit.id] ?? '';
            const busy = actingId === edit.id;
            const reasonOk = reason.trim().length >= 5;
            const d = edit.draft;
            const live = edit.live;
            return (
              <article key={edit.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4" data-testid="charter-price-edit">
                <p className="font-medium text-[var(--text-primary)]">{edit.partnerName}</p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {live ? 'Правка строки: ' : 'Новая строка: '}{editCardLabel(edit)}
                </p>
                <p className="text-xs text-[var(--text-muted)] mb-3">{when(edit.createdAt)}</p>
                <dl className="text-sm space-y-2 mb-3">
                  <div>
                    <dt className="text-[var(--text-muted)]">Цена за машину</dt>
                    <dd className="text-[var(--text-primary)]">
                      {d.priceRub === null
                        ? 'черновик цену не меняет'
                        : live ? `${formatRub(live.priceRub)} → ${formatRub(d.priceRub)}` : formatRub(d.priceRub)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--text-muted)]">Примечание</dt>
                    <dd className="text-[var(--text-primary)]">
                      {d.priceNote === null ? (live ? 'не меняется' : 'нет') : d.priceNote}
                      {live && d.priceNote !== null && <span className="text-xs text-[var(--text-muted)]"> (сейчас: {live.priceNote ?? 'нет'})</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--text-muted)]">Условия</dt>
                    <dd className="text-[var(--text-primary)] whitespace-pre-wrap">
                      {d.conditions === null ? (live ? 'не меняются' : 'нет') : d.conditions}
                      {live && d.conditions !== null && <span className="text-xs text-[var(--text-muted)]"> (сейчас: {live.conditions ?? 'нет'})</span>}
                    </dd>
                  </div>
                  {live && (
                    <div>
                      <dt className="text-[var(--text-muted)]">На сайте</dt>
                      <dd className="text-[var(--text-primary)]">
                        {d.isActive === null ? `не меняется (${yesNo(live.isActive)})` : `${yesNo(live.isActive)} → ${yesNo(d.isActive)}`}
                      </dd>
                    </div>
                  )}
                  {!live && d.validYear !== null && (
                    <div>
                      <dt className="text-[var(--text-muted)]">Год прайса</dt>
                      <dd className="text-[var(--text-primary)]">{d.validYear}</dd>
                    </div>
                  )}
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
                  <p className="text-xs text-[var(--text-muted)] mt-1">Чтобы отклонить, напишите причину — хотя бы 5 знаков. Перевозчик её увидит.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
