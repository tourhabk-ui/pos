'use client';

/**
 * Ответ партнёра на отзыв — один компонент на кабинеты оператора (отзывы о
 * турах) и владельца жилья (отзывы гостей), CRM, хвосты фазы 1 (#2325).
 * Написать, поправить, удалить; ошибка сервера видна словами.
 */
import { useState } from 'react';
import { Star, Reply, Send, Pencil, Trash2 } from 'lucide-react';

export const REVIEW_REPLY_MAX = 2000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function ReviewStars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex" aria-label={`Оценка ${rating} из 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`w-3.5 h-3.5 ${i <= rating ? 'text-[var(--warning)] fill-current' : 'text-[var(--text-muted)]'}`} />
      ))}
    </span>
  );
}

/**
 * `endpoint` — адрес ответа на этот отзыв (POST — написать или поправить,
 * DELETE — убрать). `reply` — текущий ответ, NULL — не отвечали.
 */
export function ReviewReplyBox({ endpoint, reply, where, onSaved }: {
  endpoint: string;
  reply: string | null;
  /** Где ответ увидят: «на странице тура», «на странице объекта». */
  where: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(reply ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(method: 'POST' | 'DELETE') {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(endpoint, {
        method,
        headers: method === 'DELETE' ? undefined : { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify({ reply: text.trim() }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || !isRecord(json) || json.success !== true) {
        setErr(isRecord(json) && typeof json.error === 'string' ? json.error : `Ответ не сохранён (HTTP ${res.status})`);
        return;
      }
      setEditing(false);
      onSaved();
    } catch {
      setErr('Нет связи с сервером — ответ не сохранён');
    } finally {
      setBusy(false);
    }
  }

  if (reply && !editing) {
    return (
      <div className="space-y-1.5">
        <p className="text-sm text-[var(--text-secondary)] border-l-2 border-[var(--ocean)] pl-3">
          <span className="text-[var(--text-muted)]">Ваш ответ: </span>{reply}
        </p>
        <div className="flex gap-3 pl-3">
          <button type="button" onClick={() => { setText(reply); setEditing(true); }}
            className="inline-flex items-center gap-1 text-xs text-[var(--ocean)] hover:underline">
            <Pencil className="w-3 h-3" /> Изменить
          </button>
          <button type="button" disabled={busy} onClick={() => void send('DELETE')}
            className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--danger)] disabled:opacity-50">
            <Trash2 className="w-3 h-3" /> Удалить
          </button>
        </div>
        {err && <p role="alert" className="text-xs text-[var(--danger)] pl-3">{err}</p>}
      </div>
    );
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:underline">
        <Reply className="w-3.5 h-3.5" /> Ответить
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={REVIEW_REPLY_MAX}
        rows={3}
        placeholder={`Ответ увидят все ${where}`}
        aria-label="Ответ на отзыв"
        className="ds-input w-full"
      />
      {err && <p role="alert" className="text-xs text-[var(--danger)]">{err}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || text.trim().length === 0} onClick={() => void send('POST')} className="ds-btn ds-btn-primary">
          <Send className="w-3.5 h-3.5" /> Отправить
        </button>
        <button type="button" onClick={() => { setEditing(false); setErr(null); }} className="ds-btn ds-btn-secondary">
          Отмена
        </button>
      </div>
    </div>
  );
}
