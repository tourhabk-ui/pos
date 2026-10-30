'use client';

/**
 * «Поездка состоялась» / «Не состоялась» во «Входящих» перевозчика (#2862
 * этап B): слово перевозчика о факте, один раз. Та же функция, что у кнопок
 * в MAX и Telegram (recordRideOutcome). После «состоялась» заказчик получает
 * ссылку на отзыв, под которым будет сказано, что поездку подтвердил
 * перевозчик. Итог уходит наверх экрана: карточка после ответа из списка
 * уходит, а «ссылка заказчику не ушла» должно пережить перезагрузку.
 */
import { useState } from 'react';
import { CRM_RIDE_OUTCOME_API } from './api';
import type { AnswerNotice } from './CharterRequestActions';

type Outcome = 'held' | 'not_held';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function CharterRideActions({ leadId, onAnswered }: { leadId: string; onAnswered: (notice: AnswerNotice) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(outcome: Outcome) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${CRM_RIDE_OUTCOME_API}/${encodeURIComponent(leadId)}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
      const json: unknown = await res.json().catch(() => null);
      const message = isRecord(json) && typeof json.message === 'string' ? json.message : null;
      const err = isRecord(json) && typeof json.error === 'string' ? json.error : null;
      if (res.ok && message) {
        // «не удалось» / «не выдана» — записано, но заказчику ссылку передаст менеджер.
        onAnswered({ text: message, tone: /не удалось|не выдана/.test(message) ? 'warn' : 'ok' });
      } else if (res.status === 409 && err && /уже записан/.test(err)) {
        onAnswered({ text: err, tone: 'warn' });
      } else {
        setError(err ?? `Исход не принят (${res.status})`);
      }
    } catch {
      setError('Нет связи с сервером — исход не отправлен. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={busy} onClick={() => void send('held')} className="ds-btn ds-btn-primary">Поездка состоялась</button>
        <button type="button" disabled={busy} onClick={() => void send('not_held')} className="ds-btn ds-btn-secondary">Не состоялась</button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        «Состоялась» — заказчик получит ссылку на отзыв о вас; под отзывом будет сказано, что поездку подтвердили вы. «Не состоялась» — заявка закрывается. Записывается один раз.
      </p>
      {error && <p role="status" className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
