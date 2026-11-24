'use client';

import { useState } from 'react';
import { OfferAcceptCheckbox } from '@/components/legal/OfferAcceptCheckbox';

/**
 * Принять оферту из кабинета: отметка и кнопка (этап 5 плана готовности,
 * 23.11). Одна реализация на чек-лист готовности и на просьбу при входе в
 * кабинет (24.11) — две формы одного действия разошлись бы.
 *
 * Кнопка без отметки не нажимается — и сказано почему. Сервер проверяет
 * пришедшее состояние отметки и пишет акцепт в журнал с версией оферты
 * (`POST /api/hub/partner/offer`).
 */
export function OfferAcceptForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/hub/partner/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_accepted: checked }),
      });
      const json = await res.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!res.ok || !json?.success) throw new Error(json?.error ?? 'Отметка не записана — попробуйте позже');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Отметка не записана — попробуйте позже');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1" data-testid="accept-offer">
      <OfferAcceptCheckbox checked={checked} onChange={setChecked} id={id} />
      <button
        type="button"
        className="ds-btn ds-btn-primary text-sm disabled:opacity-50"
        style={{ minHeight: 44 }}
        disabled={!checked || busy}
        onClick={() => void accept()}
      >
        Принять оферту
      </button>
      {!checked && <p className="mt-1 text-xs text-[var(--text-muted)]">Чтобы принять, поставьте отметку.</p>}
      {error && <p role="alert" className="mt-1 text-sm text-[var(--danger)]">{error}</p>}
    </div>
  );
}
