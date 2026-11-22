'use client';

/**
 * «Поправить план фразой» (фича 5 супер-планера, 23.11). Фраза уходит в
 * /api/planner/edit-phrase: разбор правилами без модели, правка — тем же
 * путём, что MCP edit_trip_plan. Показано, что сделано (по дням) и как
 * сменилась смета; «Отменить» возвращает план до правки одним нажатием.
 * Неразобранная фраза — отказ с примерами: план не меняется.
 */
import { useState } from 'react';
import { Undo2, Wand2 } from 'lucide-react';
import { PHRASE_EXAMPLES } from '@/lib/planner/phrase-edit';

export interface PhrasePlanParams {
  interests: string[];
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number[];
  budgetTier: 'economy' | 'comfort' | 'premium';
  travelStyle?: 'self' | 'operator' | 'mixed';
  restDays?: number;
}

export interface PhraseApplied<D> {
  params: PhrasePlanParams;
  days: D[];
}

interface Props<D> {
  current: () => PhraseApplied<D> | null;
  onApply: (next: PhraseApplied<D>) => void;
  onUndo: () => void;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const range = (r: [number, number]) => (r[0] === r[1] ? rub(r[0]) : `${rub(r[0])}–${rub(r[1])}`);

export function PhraseEdit<D>({ current, onApply, onUndo }: Props<D>) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ said: string[]; notes: string[]; warnings: string[]; total: { before: [number, number]; after: [number, number] } } | null>(null);

  async function submit(phrase: string) {
    const plan = current();
    if (!plan || !phrase.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/planner/edit-phrase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase, params: plan.params, days: plan.days }),
      });
      const body = await res.json().catch(() => null) as null | {
        success: boolean; error?: string; plan?: PhraseApplied<D>; said?: string[]; notes?: string[]; warnings?: string[];
        total?: { before: [number, number]; after: [number, number] };
      };
      if (!body || !body.success || !body.plan) {
        setError(body?.error ?? 'Правку посчитать не удалось — план не менял.');
        return;
      }
      onApply(body.plan);
      setDone({ said: body.said ?? [], notes: body.notes ?? [], warnings: body.warnings ?? [], total: body.total ?? { before: [0, 0], after: [0, 0] } });
      setText('');
    } catch (err) {
      console.error('[planner] правка фразой не дошла:', err instanceof Error ? err.message : String(err));
      setError('Сервер не ответил — план не менял. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Поправить план фразой" className="mb-3 rounded-xl border border-[var(--border)] p-3" data-testid="phrase-edit">
      <form onSubmit={(e) => { e.preventDefault(); void submit(text); }} className="flex gap-2">
        <label htmlFor="phrase-edit-input" className="sr-only">Поправить план фразой</label>
        <input id="phrase-edit-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
          placeholder="Поправить план: «без рыбалки», «на день короче»…"
          className="flex-1 min-w-0 rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm" />
        <button type="submit" disabled={busy || !text.trim()}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          <Wand2 className="w-4 h-4" />{busy ? 'Правлю…' : 'Поправить'}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {PHRASE_EXAMPLES.slice(0, 4).map((e) => (
          <button key={e} type="button" onClick={() => setText(e)}
            className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)]">
            {e}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-[var(--warning)]">{error}</p>}
      {done && (
        <div role="status" className="mt-2 rounded-lg bg-[var(--success)]/10 px-3 py-2 text-xs">
          <p className="font-medium">Сделано: {done.said.join('; ')}.</p>
          <ul className="mt-1 space-y-0.5 text-[var(--text-secondary)]">
            {done.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
          <p className="mt-1">Смета на группу: {range(done.total.before)} → {range(done.total.after)}.</p>
          {done.warnings.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[var(--warning)]">{done.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
          <button type="button" onClick={() => { onUndo(); setDone(null); }}
            className="mt-1.5 inline-flex items-center gap-1 font-medium text-[var(--accent)]">
            <Undo2 className="w-3.5 h-3.5" />Отменить правку
          </button>
        </div>
      )}
    </section>
  );
}
