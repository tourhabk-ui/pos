'use client';

import { Clock, Eye, EyeOff, FileText, RotateCcw, Send } from 'lucide-react';
import type { TourEditChange, TourModerationState } from '@/lib/tours/moderation';
import { TourEditDiff } from '@/components/tours/TourEditDiff';

/** Блок `moderation` из ответа редактора тура (оператор и гид). */
export interface TourModerationView {
  state: TourModerationState;
  published: boolean;
  pending: { changes: TourEditChange[]; wantsPublish: boolean; since: string } | null;
  rejected: { reason: string | null; fields: string[]; wantsPublish: boolean; at: string | null } | null;
}

interface Props {
  moderation: TourModerationView;
  busy: boolean;
  /** Сохранить форму и попросить публикацию. */
  onAskPublish: () => void;
  /** Снять тур с публикации — сразу. */
  onUnpublish: () => void;
  /** Отозвать правку или просьбу, пока её не решили. */
  onWithdraw: () => void;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

const btn = 'ds-btn ds-btn-secondary inline-flex items-center gap-1.5 text-sm disabled:opacity-50';
const btnPrimary = 'ds-btn ds-btn-primary inline-flex items-center gap-1.5 text-sm disabled:opacity-50';

/**
 * Статус тура у владельца (план готовности 23.11, этап 4).
 *
 * До этого дня здесь стояла галочка «Опубликован», и тур выходил на сайт в
 * ту же секунду. Теперь публикацию ставит только одобрение администратора, а
 * владелец видит одно из четырёх состояний и то, что именно ждёт проверки.
 * Скрыть тур («Активен») и снять с публикации по-прежнему можно сразу.
 */
export function TourModerationStatus({ moderation, busy, onAskPublish, onUnpublish, onWithdraw }: Props) {
  const { state, published, pending, rejected } = moderation;

  if (state === 'pending' && pending) {
    const since = when(pending.since);
    // Вся правка — предложение автомата платформы: владелец её не отправлял,
    // и экран не должен говорить «отправлено» от его имени.
    const platformOnly = !pending.wantsPublish && pending.changes.length > 0 && pending.changes.every((c) => Boolean(c.proposedBy));
    const fromPlatform = !platformOnly && pending.changes.some((c) => Boolean(c.proposedBy));
    return (
      <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--bg-primary)] p-3 space-y-3" role="status" data-testid="tour-moderation" data-state="pending">
        <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
          <Clock className="w-4 h-4 text-[var(--warning)]" aria-hidden />
          {pending.wantsPublish ? 'Тур на проверке' : platformOnly ? 'Платформа предложила правку' : 'Правка на проверке'}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {pending.wantsPublish
            ? 'Туристы увидят тур после одобрения администратором.'
            : platformOnly
              ? 'На сайте пока прежняя версия. Предложение выйдет после одобрения администратором. Вы можете изменить его в форме ниже или убрать.'
              : 'На сайте пока прежняя версия. Новая выйдет после одобрения администратором.'}
          {since ? (platformOnly ? ` Предложено ${since}.` : ` Отправлено ${since}.`) : ''}
          {platformOnly
            // Отказ предложению платформы владельцу не показывается: он его не присылал.
            ? ' Одобрят — правка выйдет на сайт и придёт сообщение, если подключён MAX или Telegram. Отклонят — предложение исчезнет, тур не изменится.'
            : ' Решение появится здесь; если подключён MAX или Telegram — придёт сообщением.'}
          {fromPlatform ? ' Часть правок предложила платформа — они подписаны.' : ''}
        </p>
        {pending.changes.length > 0 && (
          <div>
            <p className="text-xs text-[var(--text-muted)] mb-2">Ждёт проверки:</p>
            <TourEditDiff changes={pending.changes} />
          </div>
        )}
        <button type="button" onClick={onWithdraw} disabled={busy} className={btn}>
          <RotateCcw className="w-4 h-4" aria-hidden />
          {pending.wantsPublish ? 'Отозвать с проверки' : platformOnly ? 'Убрать предложение' : 'Отозвать правку'}
        </button>
      </div>
    );
  }

  if (state === 'rejected' && rejected) {
    return (
      <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--bg-primary)] p-3 space-y-2" role="status" data-testid="tour-moderation" data-state="rejected">
        <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
          <RotateCcw className="w-4 h-4 text-[var(--danger)]" aria-hidden />
          {rejected.wantsPublish ? 'Тур возвращён на доработку' : 'Правка отклонена'}
        </p>
        <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap break-words">
          {rejected.reason ? `Причина: ${rejected.reason}` : 'Причина не записана.'}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {published
            ? 'На сайте прежняя версия. Исправьте и сохраните — правка уйдёт на проверку снова.'
            : 'Туристы тур не видят. Исправьте и отправьте на проверку ещё раз.'}
        </p>
        {published ? (
          <button type="button" onClick={onUnpublish} disabled={busy} className={btn}>
            <EyeOff className="w-4 h-4" aria-hidden /> Снять с публикации
          </button>
        ) : (
          <button type="button" onClick={onAskPublish} disabled={busy} className={btnPrimary}>
            <Send className="w-4 h-4" aria-hidden /> Сохранить и отправить на проверку
          </button>
        )}
      </div>
    );
  }

  if (state === 'live') {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 space-y-2" role="status" data-testid="tour-moderation" data-state="live">
        <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
          <Eye className="w-4 h-4 text-[var(--success)]" aria-hidden /> Опубликован
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          Правки названия, текстов, цены, условий, снимков, сложности, длительности, места и сезона выходят на сайт
          после проверки администратором. Скрыть тур, даты и число мест можно менять сразу.
        </p>
        <button type="button" onClick={onUnpublish} disabled={busy} className={btn}>
          <EyeOff className="w-4 h-4" aria-hidden /> Снять с публикации
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 space-y-2" role="status" data-testid="tour-moderation" data-state="draft">
      <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
        <FileText className="w-4 h-4 text-[var(--text-muted)]" aria-hidden /> Черновик
      </p>
      <p className="text-sm text-[var(--text-secondary)]">
        Туристы тур не видят. На сайт он выйдет после проверки администратором.
      </p>
      <button type="button" onClick={onAskPublish} disabled={busy} className={btnPrimary}>
        <Send className="w-4 h-4" aria-hidden /> Сохранить и отправить на проверку
      </button>
    </div>
  );
}
