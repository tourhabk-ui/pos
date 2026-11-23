'use client';

import { Clock, Check, RotateCcw, X } from 'lucide-react';

export interface PricingRuleStatusProps {
  /** Что действует на сайте сейчас — словами («−10% за 7 дн. до выезда»). Не действует — `null`. */
  live: string | null;
  /** Действующее правило владелец попросил снять: до решения оно действует. */
  removalAsked: boolean;
  /** Администратор отказал в снятии действующего правила: причина. Не отказывал — `null`. */
  removalRefused?: string | null;
  /** Просьба о новом правиле: ждёт проверки либо отклонена. Нет — `null`. */
  request: { words: string; status: 'pending' | 'rejected'; reason: string | null } | null;
  /** Род правила для слов. */
  noun: 'скидка' | 'наценка';
  busy: boolean;
  /** Убрать просьбу: на цену она не влияла, поэтому убирается сразу. */
  onWithdraw: () => void;
}

const WITHOUT: Record<PricingRuleStatusProps['noun'], string> = { 'скидка': 'цена без скидки', 'наценка': 'цена без наценки' };
const NONE: Record<PricingRuleStatusProps['noun'], string> = { 'скидка': 'Скидка не назначена', 'наценка': 'Наценки нет' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Что со скидкой или наценкой тура — глазами владельца (миграция 1512; слово
 * владельца 23.11: «Наценки тоже показываются в модерации: цена тура
 * меняется только через одну дверь»).
 *
 * Правило меняет цену на сайте только после проверки, поэтому у него три
 * разных состояния, и они не сливаются в одно «сохранено»: действует, ждёт
 * проверки, отклонено. Что туристы видят прямо сейчас — сказано словами.
 */
export function PricingRuleStatus({ live, removalAsked, removalRefused = null, request, noun, busy, onWithdraw }: PricingRuleStatusProps) {
  const btn = 'ds-btn ds-btn-secondary inline-flex items-center gap-1.5 text-sm disabled:opacity-50';
  return (
    <div className="space-y-2 text-sm" data-testid="pricing-rule-status" role="status">
      {live ? (
        <p className="flex items-start gap-2 text-[var(--text-secondary)]" data-state="live">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden />
          <span>
            Действует на сайте: {live}.
            {removalAsked ? ` Вы просили снять — до решения администратора ${noun} действует.` : ''}
            {/* Отказ в снятии виден, пока владелец не попросил снова: иначе о нём знал бы только мессенджер. */}
            {!removalAsked && removalRefused ? (
              <span className="whitespace-pre-wrap break-words" data-state="removal-refused">
                {' '}В снятии отказано, {noun} действует. Причина: {removalRefused}
              </span>
            ) : null}
          </span>
        </p>
      ) : !request ? (
        <p className="text-[var(--text-muted)]" data-state="none">{NONE[noun]}</p>
      ) : null}

      {request?.status === 'pending' && (
        <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--bg-primary)] p-3 space-y-2" data-state="pending">
          <p className="flex items-start gap-2 text-[var(--text-primary)]">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden />
            <span>
              На проверке: {request.words}. Туристы увидят после одобрения администратором; сейчас на сайте —{' '}
              {live ? `прежняя ${noun}` : WITHOUT[noun]}.
            </span>
          </p>
          <button type="button" onClick={onWithdraw} disabled={busy} className={btn} style={{ minHeight: 44 }}>
            <RotateCcw className="h-4 w-4" aria-hidden />Отозвать просьбу
          </button>
        </div>
      )}

      {request?.status === 'rejected' && (
        <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--bg-primary)] p-3 space-y-2" data-state="rejected">
          <p className="flex items-start gap-2 text-[var(--text-primary)]">
            <X className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" aria-hidden />
            <span className="whitespace-pre-wrap break-words">
              {cap(noun)} отклонена: {request.words}. {request.reason ? `Причина: ${request.reason}` : 'Причина не записана.'}
            </span>
          </p>
          <p className="text-[var(--text-secondary)]">
            На сайте — {live ? `прежняя ${noun}` : WITHOUT[noun]}. Измените и отправьте на проверку ещё раз.
          </p>
          <button type="button" onClick={onWithdraw} disabled={busy} className={btn} style={{ minHeight: 44 }}>
            <X className="h-4 w-4" aria-hidden />Убрать
          </button>
        </div>
      )}
    </div>
  );
}
