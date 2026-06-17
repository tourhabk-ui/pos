'use client';

import React, { useState } from 'react';
import { AlertTriangle, X, ShieldAlert, Flame } from 'lucide-react';
import type { GeofenceBreach } from '@/lib/safety/geofence';

interface Props {
  breach: GeofenceBreach;
}

const LEVEL_STYLES = {
  warning:  { bg: 'var(--warning)',  text: 'var(--bg-card)', label: 'Внимание' },
  danger:   { bg: 'var(--danger)',   text: 'var(--bg-card)', label: 'Опасность' },
  critical: { bg: 'var(--danger)',   text: 'var(--bg-card)', label: 'Критическая опасность' },
};

const STATE_SUFFIX: Record<string, string> = {
  inside:    'Вы находитесь в зоне.',
  near:      'Вы приближаетесь к опасной зоне.',
  uncertain: 'Возможно, вы в опасной зоне (слабый GPS-сигнал).',
};

export function GeofenceAlert({ breach }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const { zone, state, distanceM } = breach;
  const style = LEVEL_STYLES[zone.level];
  const Icon  = zone.hazard === 'volcano' ? Flame : ShieldAlert;
  const distKm = (distanceM / 1_000).toFixed(1);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-20 left-3 right-3 z-[500] rounded-lg shadow-xl"
      style={{ background: style.bg, color: style.text }}
    >
      <div className="flex items-start gap-3 p-4">
        <Icon size={22} className="flex-shrink-0 mt-0.5" aria-hidden="true" />

        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm leading-tight">
            {style.label}: {zone.name}
          </p>
          <p className="text-xs mt-1 opacity-90 leading-snug">
            {STATE_SUFFIX[state]} {zone.message}
          </p>
          {state !== 'inside' && (
            <p className="text-[11px] mt-1 opacity-75">
              До центра зоны: {distKm} км
            </p>
          )}
          <p className="text-[10px] mt-1.5 opacity-60">
            Геофенсинг не гарантирует безопасность вне зон
          </p>
        </div>

        <button
          onClick={() => setDismissed(true)}
          aria-label="Закрыть предупреждение"
          className="flex-shrink-0 opacity-80 hover:opacity-100 p-1 -mr-1 -mt-1"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-4 pb-3 flex items-center gap-3">
        <AlertTriangle size={13} className="flex-shrink-0 opacity-70" aria-hidden="true" />
        <p className="text-[11px] opacity-80">
          Звоните 112 при угрозе жизни
        </p>
        <a
          href="tel:112"
          className="ml-auto text-xs font-bold underline underline-offset-2"
        >
          112
        </a>
      </div>
    </div>
  );
}
