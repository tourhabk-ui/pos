'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Compass, Loader2, AlertCircle, RefreshCw } from 'lucide-react';

/**
 * Гид на брони: выбор из команды оператора (GET /api/operator/guides) и
 * назначение (PUT /api/hub/operator/bookings/[id]/guide, миграция 1018).
 *
 * Назначенный гид видит в своём кабинете дату, тур, число людей и контакт
 * туриста — только по этой брони и пока он в команде.
 */
interface TeamGuide { id: string; name: string; isAvailable: boolean }

interface Props {
  bookingId: string;
  currentGuideId: string | null;
  currentGuideName: string | null;
  closed: boolean;
  onSaved: () => Promise<unknown>;
}

export default function GuideAssign({ bookingId, currentGuideId, currentGuideName, closed, onSaved }: Props) {
  const [team, setTeam] = useState<TeamGuide[] | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [selected, setSelected] = useState(currentGuideId ?? '');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { setSelected(currentGuideId ?? ''); }, [currentGuideId]);

  const loadTeam = useCallback(async () => {
    setTeamError(null);
    try {
      const res = await fetch('/api/operator/guides');
      const json = await res.json();
      if (!res.ok || !json.success) {
        setTeamError(json.error || 'Не удалось загрузить команду');
        setTeam(null);
        return;
      }
      setTeam(json.data ?? []);
    } catch {
      setTeamError('Сеть недоступна. Команда не загружена.');
      setTeam(null);
    }
  }, []);

  useEffect(() => { if (!closed) void loadTeam(); }, [closed, loadTeam]);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/hub/operator/bookings/${bookingId}/guide`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidePartnerId: selected || null }),
      });
      const json = await res.json();
      const ok = res.ok && json.success;
      setNotice({ ok, text: ok ? json.message : (json.error || 'Не удалось назначить гида') });
      if (ok) await onSaved();
    } catch {
      setNotice({ ok: false, text: 'Сеть недоступна. Назначение не сохранено.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-card p-5 mb-6">
      <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-4 flex items-center gap-2">
        <Compass className="w-4 h-4" /> Гид
      </h2>
      <p className="text-sm text-[var(--text-primary)] mb-3">
        {currentGuideName ? `Назначен: ${currentGuideName}` : 'Гид не назначен'}
      </p>

      {closed ? (
        <p className="text-xs text-[var(--text-muted)]">Бронь закрыта — гида на неё не назначают.</p>
      ) : teamError ? (
        <div className="flex items-start gap-3 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 text-[var(--danger)] shrink-0" />
          <p className="flex-1 text-[var(--text-primary)]">{teamError}</p>
          <button type="button" onClick={() => void loadTeam()} className="ds-btn ds-btn-secondary inline-flex items-center gap-1.5 shrink-0">
            <RefreshCw className="w-4 h-4" /> Повторить
          </button>
        </div>
      ) : team === null ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" /> Команда...
        </div>
      ) : team.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">
          В команде пока нет гидов.{' '}
          <Link href="/hub/operator/guides" className="text-[var(--ocean)] hover:underline">Пригласить гида</Link>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Гид на брони"
            className="ds-input min-w-[220px]"
          >
            <option value="">— без гида —</option>
            {team.map((g) => (
              <option key={g.id} value={g.id}>{g.name}{g.isAvailable ? '' : ' (неактивен)'}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || selected === (currentGuideId ?? '')}
            className="ds-btn ds-btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Сохранить
          </button>
        </div>
      )}

      {notice && (
        <p className={`text-sm mt-3 ${notice.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{notice.text}</p>
      )}
    </div>
  );
}
