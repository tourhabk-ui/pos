'use client';
/**
 * Карточка толчка по тапу на /map (02.10). Время — по Камчатке и сколько
 * часов назад: «04:34» без пояса читается как время телефона, а на
 * Камчатке часы человека и UTC расходятся на 12 часов.
 */
import { Activity, X } from 'lucide-react';
import type { VedarMapQuake } from '@/components/shared/VedarMap';

function kamchatkaTime(ms: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Kamchatka', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return `${h} ч ${min % 60} мин назад`;
}

export function QuakeCard({ quake, onClose }: { quake: VedarMapQuake; onClose: () => void }) {
  return (
    <div
      data-theme="dark"
      className="fx-glass-dense absolute left-3 right-3 bottom-14 z-[600] flex items-start gap-3 px-4 py-3 rounded-2xl border transition-all duration-200"
      style={{ borderColor: 'var(--danger)', color: 'var(--glass-fg)' }}
      role="dialog"
      aria-label={`Землетрясение M${quake.magnitude.toFixed(1)}`}
    >
      <Activity className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--danger)' }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">Землетрясение M{quake.magnitude.toFixed(1)}</p>
        <p className="text-xs" style={{ color: 'var(--glass-fg-muted)' }}>
          {kamchatkaTime(quake.time)} по Камчатке · {ago(quake.time)}
          {quake.depth !== null ? ` · глубина ${quake.depth} км` : ' · глубина не указана'}
        </p>
      </div>
      <button type="button" onClick={onClose} aria-label="Закрыть"
        className="w-11 h-11 -mr-2 -mt-2 flex items-center justify-center rounded-full">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
