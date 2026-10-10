'use client';

/**
 * Ответ на запрос мест прямо во «Входящих» (CRM, хвосты фазы 1, #2325):
 * «Есть места», «Мест нет», «Предложить другую дату». Та же функция, что у
 * кнопки в MAX и у страницы по ссылке, — answerSeatRequest. Контактов туриста
 * здесь нет: после «Есть места» они приходят уведомлением о брони (29.09).
 */
import { useState } from 'react';
import { CRM_SEAT_ANSWER_API } from './api';

type Answer = 'yes' | 'no' | 'other_date';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function SeatRequestActions({ requestId, onAnswered }: { requestId: string; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [pickDate, setPickDate] = useState(false);
  const [altDate, setAltDate] = useState('');
  const [result, setResult] = useState<{ text: string; tone: 'ok' | 'warn' | 'error' } | null>(null);

  async function send(answer: Answer) {
    if (answer === 'other_date' && !altDate) {
      setResult({ text: 'Выберите дату, которую предлагаете', tone: 'error' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`${CRM_SEAT_ANSWER_API}/${encodeURIComponent(requestId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answer === 'other_date' ? { answer, date: altDate } : { answer }),
      });
      const json: unknown = await res.json().catch(() => null);
      const data = isRecord(json) && isRecord(json.data) ? json.data : null;
      const error = isRecord(json) && typeof json.error === 'string' ? json.error : null;
      const reason = isRecord(json) && typeof json.reason === 'string' ? json.reason : null;
      if (res.ok && data && typeof data.message === 'string') {
        // «Бронь не завелась» — не успех: оператору надо проверить кабинет.
        setResult({ text: data.message, tone: data.failed === true ? 'warn' : 'ok' });
        onAnswered();
      } else if (reason === 'accepted_unfinished') {
        // Ответ принят, исход не записан: повторять нельзя — это не ошибка ввода.
        setResult({ text: error ?? 'Ответ принят.', tone: 'warn' });
        onAnswered();
      } else {
        setResult({ text: error ?? `Ответ не принят (${res.status})`, tone: 'error' });
      }
    } catch {
      setResult({ text: 'Нет связи с сервером — ответ не отправлен. Попробуйте ещё раз.', tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const toneClass = result?.tone === 'ok' ? 'text-[var(--success)]' : result?.tone === 'warn' ? 'text-[var(--warning)]' : 'text-[var(--danger)]';

  return (
    <div className="space-y-2 pt-1">
      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={busy} onClick={() => void send('yes')} className="ds-btn ds-btn-primary">Есть места</button>
        <button type="button" disabled={busy} onClick={() => void send('no')} className="ds-btn ds-btn-secondary">Мест нет</button>
        <button type="button" disabled={busy} onClick={() => setPickDate((v) => !v)} aria-expanded={pickDate} className="ds-btn ds-btn-secondary">
          Другая дата
        </button>
      </div>
      {pickDate && (
        <div className="flex gap-2 flex-wrap items-center">
          <input
            type="date"
            value={altDate}
            onChange={(e) => setAltDate(e.target.value)}
            aria-label="Дата, которую предлагаете туристу"
            className="ds-input"
          />
          <button type="button" disabled={busy || !altDate} onClick={() => void send('other_date')} className="ds-btn ds-btn-secondary">
            Предложить
          </button>
        </div>
      )}
      {result && <p role="status" className={`text-xs ${toneClass}`}>{result.text}</p>}
    </div>
  );
}
