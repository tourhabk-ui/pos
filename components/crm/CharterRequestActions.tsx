'use client';

/**
 * Ответ перевозчика на заявку на машину прямо во «Входящих» (#2862 этап A):
 * «Беру» — готов выполнить и свяжется с заказчиком сам, «Не могу» — заказчик
 * получает сообщение Ведара об отказе (этап 2б-2), а перевозчик — что с ним
 * вышло. Та же функция, что у кнопки под заявкой в MAX
 * и в карточке кабинета в чате (answerRentalRequest). Машина заявкой не
 * закрепляется, суммы здесь нет (§14); контакты заказчика — в самой заявке,
 * которую перевозчик получил в MAX, и в «Клиентах».
 */
import { useState } from 'react';
import { CRM_CHARTER_ANSWER_API } from './api';

type Answer = 'take' | 'decline';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface AnswerNotice {
  text: string;
  tone: 'ok' | 'warn';
}

/**
 * `onAnswered` получает итог ответа: экран «Входящих» перезагружает список,
 * и эта карточка из него уходит — итог («заказчику сообщил» / «не ушло —
 * свяжитесь сами») должен пережить перезагрузку, иначе его никто не увидит.
 */
export function CharterRequestActions({ leadId, onAnswered }: { leadId: string; onAnswered: (notice: AnswerNotice) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: 'error' } | null>(null);

  async function send(answer: Answer) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`${CRM_CHARTER_ANSWER_API}/${encodeURIComponent(leadId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      const json: unknown = await res.json().catch(() => null);
      const message = isRecord(json) && typeof json.message === 'string' ? json.message : null;
      const error = isRecord(json) && typeof json.error === 'string' ? json.error : null;
      if (res.ok && message) {
        // Ответ записан, а до заказчика не дошло — сервер называет это признаком `attention`.
        onAnswered({ text: message, tone: isRecord(json) && json.attention === true ? 'warn' : 'ok' });
      } else if (res.status === 409) {
        // Ответ уже был: повторять нельзя, это не ошибка ввода.
        onAnswered({ text: error ?? 'Ответ уже записан.', tone: 'warn' });
      } else {
        setResult({ text: error ?? `Ответ не принят (${res.status})`, tone: 'error' });
      }
    } catch {
      // Ответ мог записаться до обрыва связи: «не отправлен» было бы догадкой. Повтор безопасен — второго ответа не бывает.
      setResult({ text: 'Нет связи с сервером. Записан ли ответ — неизвестно: нажмите ещё раз, второй раз он не запишется.', tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={busy} onClick={() => void send('take')} className="ds-btn ds-btn-primary">Беру</button>
        <button type="button" disabled={busy} onClick={() => void send('decline')} className="ds-btn ds-btn-secondary">Не могу</button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        «Беру» — вы свяжетесь с заказчиком сами и договоритесь напрямую; машина заявкой не закрепляется. «Не могу» — заказчику уйдёт сообщение об этом; что ушло, появится здесь после ответа.
      </p>
      {result && <p role="status" className="text-xs text-[var(--danger)]">{result.text}</p>}
    </div>
  );
}
