'use client';

/**
 * Голосование группы по дням поездки — без входа (фича 6, слово владельца
 * 23.11). 👍/👎 на день, повторное нажатие снимает голос. Итог видят все;
 * менять план может только организатор — это сказано прямо.
 */
import { useEffect, useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { tallyWords, type DayTally } from '@/lib/trips/trip-vote-words';
import { planDayDate } from '@/lib/planner/day-tour-link';
import { dayDateShort } from '@/lib/planner/plan-notes';

interface VoteData {
  title: string; arrival_date: string | null; days: Array<{ day: number; title: string }>;
  deadline_at: string; open: boolean; voters: number; max_voters: number;
  tallies: DayTally[]; mine: Record<string, number>;
}

function deadlineWords(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export default function VoteClient({ token }: { token: string }) {
  const [data, setData] = useState<VoteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDay, setBusyDay] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/trip-vote/${encodeURIComponent(token)}`, { signal: ctrl.signal, cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { success: boolean; data?: VoteData; error?: string }) => (d.success && d.data ? setData(d.data) : setError(d.error ?? 'Голосование не открылось.')))
      .catch((e: unknown) => { if ((e as { name?: string })?.name !== 'AbortError') setError('Сервер не ответил — обновите страницу.'); });
    return () => ctrl.abort();
  }, [token]);

  async function vote(day: number, v: 1 | -1) {
    if (!data) return;
    const next = data.mine[String(day)] === v ? 0 : v;
    setBusyDay(day);
    setError(null);
    try {
      const r = await fetch(`/api/trip-vote/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, vote: next }),
      });
      const d = await r.json() as { success: boolean; data?: VoteData; error?: string };
      if (d.success && d.data) setData(d.data); else setError(d.error ?? 'Голос не записался.');
    } catch {
      setError('Сервер не ответил — голос не записан.');
    } finally {
      setBusyDay(null);
    }
  }

  if (!data) {
    return <main className="max-w-2xl mx-auto px-4 py-10 text-sm text-[var(--text-secondary)]">{error ?? 'Загружаю голосование…'}</main>;
  }
  const byDay = new Map(data.tallies.map((t) => [t.day, t]));
  return (
    <main className="max-w-2xl mx-auto px-4 py-8 space-y-4" data-vote-page>
      <header>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">{data.title}</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {data.open
            ? `Голосование до ${deadlineWords(data.deadline_at)} (Камчатка). Поставьте 👍 или 👎 дням — организатор увидит итог и решит, менять ли день.`
            : 'Срок голосования вышел — итог у организатора.'}
        </p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Проголосовали: {data.voters} из возможных {data.max_voters}. Вход не нужен; имя и телефон не спрашиваем.</p>
      </header>
      {error && <p role="alert" className="text-sm text-[var(--warning)]">{error}</p>}
      <ol className="space-y-2">
        {data.days.map((d) => {
          const t = byDay.get(d.day) ?? { day: d.day, up: 0, down: 0 };
          const mine = data.mine[String(d.day)] ?? 0;
          const date = data.arrival_date ? dayDateShort(planDayDate(data.arrival_date.slice(0, 10), d.day - 1)) : '';
          return (
            <li key={d.day} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 flex items-center gap-3" data-vote-day={d.day}>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[var(--text-muted)]">День {d.day}{date ? ` · ${date}` : ''}</p>
                <p className="text-sm font-medium text-[var(--text-primary)]">{d.title}</p>
                <p className="text-xs text-[var(--text-secondary)]">{tallyWords(t)}</p>
              </div>
              <button type="button" aria-label={`За день ${d.day}`} aria-pressed={mine === 1} disabled={!data.open || busyDay === d.day}
                onClick={() => void vote(d.day, 1)}
                className={`rounded-lg border px-3 py-2 ${mine === 1 ? 'border-[var(--success)] bg-[var(--success)]/10' : 'border-[var(--border)]'} disabled:opacity-50`}>
                <ThumbsUp className="w-4 h-4" />
              </button>
              <button type="button" aria-label={`Против дня ${d.day}`} aria-pressed={mine === -1} disabled={!data.open || busyDay === d.day}
                onClick={() => void vote(d.day, -1)}
                className={`rounded-lg border px-3 py-2 ${mine === -1 ? 'border-[var(--warning)] bg-[var(--warning)]/10' : 'border-[var(--border)]'} disabled:opacity-50`}>
                <ThumbsDown className="w-4 h-4" />
              </button>
            </li>
          );
        })}
      </ol>
    </main>
  );
}
