'use client';

/**
 * Плашка «обстановка в крае» поверх полевой карты (#1428).
 *
 * Логика исходов — `lib/safety/map-threat-summary` (чистая, со сторожем).
 * Здесь только доставка: сеть → кеш телефона → «неизвестно». Последний
 * ответ хранится в localStorage, чтобы без сети плашка говорила, что было
 * известно и когда, а не пропадала и не рисовала спокойствие.
 *
 * Стекло поверх карты — по §2 CLAUDE.md: тёмное, содержимое в тёмной теме,
 * тревога узнаётся кромкой цвета предупреждения, а не заливкой.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { mapThreatSummary, type MapThreatSummary, type SafetyStatusPayload } from '@/lib/safety/map-threat-summary';

const CACHE_KEY = 'vedar_map_threat';

function readCache(): { data: SafetyStatusPayload; ts: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: SafetyStatusPayload; ts?: number };
    return parsed.data && typeof parsed.ts === 'number' ? { data: parsed.data, ts: parsed.ts } : null;
  } catch {
    return null;
  }
}

function writeCache(data: SafetyStatusPayload): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch { /* приватный режим */ }
}

export function MapThreatChip() {
  const [summary, setSummary] = useState<MapThreatSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = readCache();
    if (cached) setSummary(mapThreatSummary(cached.data, Date.now() - cached.ts));

    fetch('/api/public/safety-status')
      .then(r => r.json())
      .then((j: { success?: boolean; data?: SafetyStatusPayload }) => {
        if (cancelled) return;
        if (j?.success && j.data) {
          // Недоступный источник не затирает прежний известный ответ.
          if (j.data.unavailable !== true) writeCache(j.data);
          setSummary(j.data.unavailable === true && cached
            ? mapThreatSummary(cached.data, Date.now() - cached.ts)
            : mapThreatSummary(j.data));
        } else if (!cached) {
          setSummary(mapThreatSummary(null));
        }
      })
      .catch(() => {
        // Без сети: кеш уже показан; кеша нет — честное «неизвестно».
        if (!cancelled && !cached) setSummary(mapThreatSummary(null));
      });
    return () => { cancelled = true; };
  }, []);

  if (!summary) return null;

  const Icon = summary.state === 'alert' ? ShieldAlert : summary.state === 'calm' ? ShieldCheck : ShieldQuestion;
  const edge = summary.state === 'alert' ? 'var(--warning)' : 'rgba(255,255,255,0.15)';

  return (
    <Link
      href="/safety#radar"
      data-theme="dark"
      aria-label={`${summary.label}${summary.detail ? `. ${summary.detail}` : ''}. Открыть радар угроз`}
      className="fx-glass flex items-start gap-2 max-w-[260px] px-3 py-2 rounded-2xl transition-all duration-200"
      style={{ borderColor: edge, color: 'var(--glass-fg)' }}
    >
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: summary.state === 'alert' ? 'var(--warning)' : 'var(--glass-fg-muted)' }} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-xs font-bold leading-tight">{summary.label}</span>
        {summary.detail && (
          <span className="block text-[11px] leading-snug mt-0.5 line-clamp-2" style={{ color: 'var(--glass-fg-muted)' }}>
            {summary.detail}
          </span>
        )}
      </span>
    </Link>
  );
}
