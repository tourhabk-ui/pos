'use client';

import { useEffect, useState } from 'react';

/**
 * Кем вошедший приходится кабинету оператора (CRM фаза 2г): владелец или
 * менеджер команды и права, которые дал владелец. Читает /api/hub/operator/me.
 *
 * Меню и кнопки по этому ответу — удобство, а не защита: деньги и настройки
 * закрывает сервер (requireOperatorOwner, сторож operator-team-gates).
 * Поэтому «не узнали» (unknown) показывает кабинет как раньше — сервер всё
 * равно откажет, а прятать разделы владельцу из-за сбоя сети нельзя.
 */
export interface OperatorSeatPerms {
  can_edit_prices: boolean;
  can_cancel_bookings: boolean;
}

export type OperatorSeat =
  | { state: 'loading' }
  | { state: 'unknown' }
  | { state: 'ok'; kind: 'owner' | 'manager'; perms: OperatorSeatPerms };

function isPerms(v: unknown): v is OperatorSeatPerms {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.can_edit_prices === 'boolean' && typeof p.can_cancel_bookings === 'boolean';
}

export function parseOperatorSeat(json: unknown): OperatorSeat {
  if (!json || typeof json !== 'object') return { state: 'unknown' };
  const j = json as { success?: unknown; data?: { kind?: unknown; perms?: unknown } };
  if (j.success !== true || !j.data) return { state: 'unknown' };
  const { kind, perms } = j.data;
  if ((kind === 'owner' || kind === 'manager') && isPerms(perms)) return { state: 'ok', kind, perms };
  return { state: 'unknown' };
}

export function useOperatorSeat(): OperatorSeat {
  const [seat, setSeat] = useState<OperatorSeat>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    fetch('/api/hub/operator/me')
      .then(r => r.json().catch(() => null))
      .then(json => { if (alive) setSeat(parseOperatorSeat(json)); })
      .catch(() => { if (alive) setSeat({ state: 'unknown' }); });
    return () => { alive = false; };
  }, []);
  return seat;
}

/** Менеджер — только при точном ответе сервера; «не узнали» — не менеджер. */
export function isManagerSeat(seat: OperatorSeat): seat is Extract<OperatorSeat, { state: 'ok' }> & { kind: 'manager' } {
  return seat.state === 'ok' && seat.kind === 'manager';
}
