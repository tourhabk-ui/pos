'use client';

import { useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import type { PendingPricingRule } from '@/lib/tours/pricing-rule-words';

/** Карточка очереди — то, что отдаёт GET /api/admin/moderation/pricing-rules. */
export type PricingRuleCard = PendingPricingRule;

interface Props {
  loading: boolean;
  error: string;
  rules: PricingRuleCard[];
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

/** Цена словами; не прочитана — так и сказано, ноль не выдумывается. */
function rub(value: number | null): string {
  return value === null ? 'цена не прочитана' : `${value.toLocaleString('ru-RU')} ₽`;
}

/**
 * Очередь скидок и наценок (миграция 1512; слово владельца 23.11: «Наценки
 * тоже показываются в модерации: цена тура меняется только через одну дверь»).
 *
 * На сайте этого ещё нет: новое правило цену не меняет, пока его не одобрили,
 * а правило, которое просят снять, действует до решения. Карточка показывает
 * само правило и то, как изменится цена в день, когда оно срабатывает.
 * Одобряется ровно показанное: отпечаток карточки едет вместе с решением.
 */
export function PricingRuleQueue({ loading, error, rules, actingId, actionError, onRetry, onApprove, onReject }: Props) {
  const [reasons, setReasons] = useState<Record<string, string>>({});

  return (
    <section className="mb-8" aria-labelledby="pricing-rules-heading">
      <h2 id="pricing-rules-heading" className="text-lg font-bold text-[var(--text-primary)] mb-1">
        Скидки и наценки туров
      </h2>
      <p className="text-sm text-[var(--text-muted)] mb-3">
        Скидка или наценка меняет цену, которую видит турист. Новое правило начинает действовать только после одобрения;
        правило, которое владелец просит снять, действует, пока вы не решили.
      </p>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center py-8 gap-3">
          <AlertCircle className="w-7 h-7 text-[var(--danger)]" />
          <p className="text-[var(--text-secondary)] text-sm">Не смог загрузить скидки и наценки. {error}</p>
          <button type="button" onClick={onRetry} className="text-sm text-[var(--accent)] underline">Повторить</button>
        </div>
      ) : rules.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)] py-4">Скидок и наценок на проверке нет.</p>
      ) : (
        <div className="space-y-3">
          {actionError && <p className="text-sm text-[var(--danger)]" role="alert">{actionError}</p>}
          {rules.map((rule) => {
            const reason = reasons[rule.id] ?? '';
            const busy = actingId === rule.id;
            const reasonOk = reason.trim().length >= 5;
            const removal = rule.kind === 'removal';
            const owner = OWNER_WORD[rule.partnerCategory ?? ''] ?? 'Партнёр';
            return (
              <article
                key={rule.id}
                className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4"
                data-testid="pricing-rule"
                aria-label={`${removal ? 'Снять правило цены' : 'Новое правило цены'}: ${rule.tourTitle}`}
              >
                <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                  {removal ? 'Владелец просит снять правило' : 'Новое правило цены'}
                </p>
                <p className="font-medium text-[var(--text-primary)]">{rule.tourTitle}</p>
                <p className="text-sm text-[var(--text-secondary)]">{owner}: {rule.partnerName}</p>
                <p className="text-xs text-[var(--text-muted)] mb-3">
                  {when(rule.since)}
                  {rule.tourOnSite ? (
                    <>
                      {' · '}
                      <a href={`/catalog/tours/${rule.tourId}`} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] underline">
                        тур на сайте
                      </a>
                    </>
                  ) : ' · тура на сайте сейчас нет'}
                </p>

                <dl className="space-y-2 mb-3">
                  <div>
                    <dt className="text-xs text-[var(--text-muted)]">{removal ? 'Действует сейчас' : 'Правило'}</dt>
                    <dd className="text-sm text-[var(--text-primary)]" data-testid="pricing-rule-words">{rule.words}</dd>
                  </div>
                  {rule.replaces && (
                    <div>
                      <dt className="text-xs text-[var(--text-muted)]">Заменит действующее</dt>
                      <dd className="text-sm text-[var(--text-primary)]" data-testid="pricing-rule-replaces">{rule.replaces}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-xs text-[var(--text-muted)]">Цена за единицу в день, когда правило срабатывает</dt>
                    <dd className="text-sm text-[var(--text-primary)]" data-testid="pricing-rule-price">
                      сейчас {rub(rule.priceNow)} → после решения {rub(rule.priceAfter)}
                      <span className="text-[var(--text-muted)]"> (цена владельца — {rub(rule.basePrice)})</span>
                    </dd>
                  </div>
                </dl>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="flex-1 text-xs text-[var(--text-muted)]">
                    Причина отказа
                    <textarea
                      value={reason}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [rule.id]: e.target.value }))}
                      rows={2}
                      maxLength={1000}
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    />
                  </label>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onApprove(rule.id)}
                      disabled={busy}
                      className="min-h-[44px] px-3 py-2 rounded-lg bg-[var(--success)] text-[var(--text-primary)] text-sm font-medium inline-flex items-center gap-1 hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      {removal ? 'Снять правило' : 'Одобрить'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject(rule.id, reason.trim())}
                      disabled={busy || !reasonOk}
                      className="min-h-[44px] px-3 py-2 rounded-lg bg-[var(--danger)] text-[var(--text-primary)] text-sm font-medium inline-flex items-center gap-1 hover:opacity-90 disabled:opacity-50"
                    >
                      <X className="w-4 h-4" />
                      {removal ? 'Оставить правило' : 'Отклонить'}
                    </button>
                  </div>
                </div>
                {!reasonOk && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">Чтобы отказать, напишите причину — хотя бы 5 знаков. Владелец тура её увидит.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
