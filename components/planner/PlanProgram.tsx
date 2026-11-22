'use client';

/**
 * «Подробная программа» по кнопке (фича 7, 23.11): план на экране сразу,
 * текст модели — только когда человек его открыл, один раз на план.
 * Строки-оговорки движка (МЧС, «не проверили») стоят всегда — они не от модели.
 */
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export function PlanProgram({ plain, body }: {
  /** Текст движка: первая строка — сводка, дальше оговорки. */
  plain: string;
  /** Что отправить на /api/planner/itinerary; null — плана нет. */
  body: () => unknown;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notes = plain.split('\n').slice(1).filter((l) => l.trim());

  async function load() {
    const b = body();
    if (!b || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/planner/itinerary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
      });
      const data = await res.json().catch(() => null) as null | { success: boolean; text?: string; error?: string };
      if (data?.success && data.text) setText(data.text);
      else setError(data?.error ?? 'Программу написать не получилось — план от этого не меняется.');
    } catch (err) {
      console.error('[planner] программа не дошла:', err instanceof Error ? err.message : String(err));
      setError('Сервер не ответил — попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-plan-program>
      <button type="button"
        onClick={() => { const next = !open; setOpen(next); if (next && text === null) void load(); }}
        className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        {open ? 'Скрыть программу' : 'Подробная программа'}
      </button>
      {open && (
        <div className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed space-y-1.5 p-3 bg-[var(--bg-hover)] rounded-lg">
          {busy && <p role="status">Пишем программу по вашему плану…</p>}
          {error && <p role="alert" className="text-[var(--warning)]">{error}</p>}
          {text && text.split('\n').filter((l) => l.trim()).map((line, i) => <p key={`t${i}`}>{line}</p>)}
          {!busy && !text && !error && <p>{plain.split('\n')[0]}</p>}
          {notes.map((line, i) => <p key={`n${i}`}>{line}</p>)}
        </div>
      )}
    </div>
  );
}
