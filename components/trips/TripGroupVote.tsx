'use client';

/**
 * Голосование группы по дням — сторона организатора (фича 6, слово владельца
 * 23.11: голос по ссылке без входа, итог предлагает заменить день одной
 * кнопкой; заменяет только владелец). Замена — тем же путём, что у проверки
 * поездки: /api/trips/[id]/replace-day → applyPlanEdit replace_day, новым
 * черновиком; сама поездка не меняется.
 */
import { useCallback, useEffect, useState } from 'react';
import { Users, Copy, Check } from 'lucide-react';
import { ReplaceDay } from '@/components/trips/TripNowCheck';
import { groupAgainst, tallyWords, type DayTally } from '@/lib/trips/trip-vote-words';

interface LinkState { deadline_at: string; open: boolean; voters: number; tallies: DayTally[] }
const HOURS: Array<[number, string]> = [[24, 'сутки'], [48, '2 дня'], [72, '3 дня'], [168, 'неделя']];

function deadlineWords(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export function TripGroupVote({ tripId, days }: { tripId: string; days: ReadonlyArray<{ day: number; title: string; activityType?: string | null; type?: string }> }) {
  const [link, setLink] = useState<LinkState | null | undefined>(undefined);
  const [hours, setHours] = useState(48);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/trips/${tripId}/vote-link`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { success: boolean; data?: { link: LinkState | null }; error?: string }) => {
        if (d.success && d.data) setLink(d.data.link); else setError(d.error ?? 'Итог голосования не прочитался.');
      })
      .catch(() => setError('Сервер не ответил — итог голосования не прочитан.'));
  }, [tripId]);
  useEffect(() => { load(); }, [load]);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/trips/${tripId}/vote-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours }) });
      const d = await r.json() as { success: boolean; data?: { path: string }; error?: string };
      if (d.success && d.data) { setFresh(`${window.location.origin}${d.data.path}`); setCopied(false); load(); }
      else setError(d.error ?? 'Голосование не открылось.');
    } catch {
      setError('Сервер не ответил — голосование не открыто.');
    } finally {
      setBusy(false);
    }
  }

  const against = (link?.tallies ?? []).filter(groupAgainst);
  return (
    <section className="rounded-lg p-4 space-y-3 bg-[var(--bg-card)] border border-[var(--border)]" data-trip-group-vote>
      <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]"><Users className="w-4 h-4 text-[var(--accent)]" />Спросить группу</p>
      <p className="text-xs text-[var(--text-secondary)]">
        Участники ставят 👍 или 👎 дням по ссылке, без входа и без имени. Менять план можете только вы.
        Защита от накрутки — срок, не больше 30 голосующих и лимит частоты; от человека с десятком браузеров она не спасает.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="vote-hours" className="text-xs text-[var(--text-secondary)]">Срок</label>
        <select id="vote-hours" className="ds-input text-base sm:text-sm py-1 w-auto" value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={busy}>
          {HOURS.map(([h, w]) => <option key={h} value={h}>{w}</option>)}
        </select>
        <button type="button" className="ds-btn ds-btn-secondary text-sm" onClick={() => void open()} disabled={busy}>
          {busy ? 'Открываю…' : link ? 'Новая ссылка (старая закроется)' : 'Открыть голосование'}
        </button>
      </div>
      {fresh && (
        <div className="text-xs space-y-1" role="status">
          <p className="text-[var(--text-primary)]">Ссылка видна только сейчас — скопируйте и отправьте группе:</p>
          <div className="flex items-center gap-2">
            <input readOnly value={fresh} className="ds-input text-xs flex-1 min-w-0" aria-label="Ссылка голосования" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="ds-btn ds-btn-secondary text-xs" onClick={() => { void navigator.clipboard?.writeText(fresh).then(() => setCopied(true)); }}>
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-[var(--warning)]">{error}</p>}
      {link && (
        <div className="text-xs space-y-2" data-vote-result>
          <p className="text-[var(--text-secondary)]">
            {link.open ? `Голосование до ${deadlineWords(link.deadline_at)} (Камчатка)` : 'Срок голосования вышел'} · проголосовали: {link.voters}
          </p>
          {link.tallies.length === 0
            ? <p className="text-[var(--text-muted)]">Голосов пока нет.</p>
            : (
              <ul className="space-y-1">
                {link.tallies.map((t) => {
                  const d = days.find((x) => x.day === t.day);
                  return <li key={t.day}>День {t.day}{d ? ` «${d.title}»` : ''}: {tallyWords(t)}</li>;
                })}
              </ul>
            )}
          {against.map((t) => {
            const d = days.find((x) => x.day === t.day);
            return (
              <div key={`r${t.day}`} className="rounded-md border border-[var(--warning)]/30 p-2" data-vote-against={t.day}>
                <p className="text-[var(--warning)]">Группа против дня {t.day}: {tallyWords(t)}. Подобрать замену?</p>
                <ReplaceDay tripId={tripId} day={t.day} current={d?.activityType ?? null} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
