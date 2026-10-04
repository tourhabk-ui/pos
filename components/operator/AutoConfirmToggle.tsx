'use client';

/**
 * Настройка оператора «подтверждать брони автоматически» (решение владельца
 * 04.10). Включённая, она подтверждает бронь сразу, если дата есть в
 * расписании и места есть — турист может оплатить без ожидания. Оператор
 * отвечает за то, что расписание актуально: это сказано рядом с переключателем.
 *
 * Состояние — три исхода: включено, выключено, «не смогли прочитать». Третье
 * не рисуется как «выключено» (§4.0).
 */
import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';

export function AutoConfirmToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/hub/operator/settings/auto-confirm')
      .then(async (r) => {
        const j = await r.json().catch(() => null) as { enabled?: boolean; error?: string } | null;
        if (!alive) return;
        if (!r.ok || typeof j?.enabled !== 'boolean') { setError(j?.error ?? 'Не удалось прочитать настройку'); return; }
        setEnabled(j.enabled);
      })
      .catch(() => { if (alive) setError('Не удалось прочитать настройку'); });
    return () => { alive = false; };
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/hub/operator/settings/auto-confirm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const j = await r.json().catch(() => null) as { enabled?: boolean; error?: string } | null;
      if (!r.ok || typeof j?.enabled !== 'boolean') throw new Error(j?.error ?? 'Не удалось сохранить настройку');
      setEnabled(j.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить настройку');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-card p-4 flex items-start gap-3">
      <Zap className="w-5 h-5 shrink-0 mt-0.5 text-[var(--accent)]" />
      <div className="flex-1 min-w-0">
        <label className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={enabled === true}
            disabled={enabled === null || saving}
            onChange={(e) => { void toggle(e.target.checked); }}
          />
          Подтверждать брони автоматически
        </label>
        <p className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
          Если дата есть в вашем расписании и на неё есть места, бронь подтверждается сразу, и турист может оплатить
          без ожидания. Даты, введённые туристом вне расписания, вы подтверждаете сами. Включая, вы отвечаете за то,
          что расписание и места в календаре актуальны.
        </p>
        {enabled === null && !error && <p className="mt-1 text-xs text-[var(--text-muted)]">Загружаем настройку…</p>}
        {error && <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
      </div>
    </div>
  );
}
