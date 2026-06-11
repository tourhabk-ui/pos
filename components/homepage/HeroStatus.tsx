import Image from 'next/image';
import { AlertTriangle, ShieldCheck, Info, ArrowRight, Search } from 'lucide-react';

export interface SafetyStatusData {
  hasAlert: boolean;
  maxSeverity: number;
  activeCount: number;
  topTitle: string | null;
  topType: string | null;
  dataUpdatedAt: string | null;
  source: string;
}

interface HeroStatusProps {
  safety: SafetyStatusData | null;
  fetchedAt: string;
}

const STALE_MS = 24 * 60 * 60 * 1000;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kamchatka',
    });
  } catch {
    return '';
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kamchatka',
    });
  } catch {
    return iso;
  }
}

export function HeroStatus({ safety, fetchedAt }: HeroStatusProps) {
  const updatedAt = safety?.dataUpdatedAt ? new Date(safety.dataUpdatedAt) : null;
  const isStale = !updatedAt || Date.now() - updatedAt.getTime() > STALE_MS;

  const severity = !isStale ? (safety?.maxSeverity ?? 0) : 0;
  const hasAlert = !isStale && (safety?.hasAlert ?? false);

  let badgeLabel: string;
  let badgeColor: string;
  let BadgeIcon: React.ElementType;

  if (isStale) {
    const staleFrom = updatedAt
      ? formatDateTime(updatedAt.toISOString())
      : formatDateTime(fetchedAt);
    badgeLabel = `Нет свежих данных с ${staleFrom}`;
    badgeColor = 'var(--warning)';
    BadgeIcon = AlertTriangle;
  } else if (severity >= 3) {
    badgeLabel = 'Высокая опасность';
    badgeColor = 'var(--danger)';
    BadgeIcon = AlertTriangle;
  } else if (severity >= 1) {
    badgeLabel = 'Внимание';
    badgeColor = 'var(--warning)';
    BadgeIcon = Info;
  } else {
    badgeLabel = 'Обычный день';
    badgeColor = 'var(--success)';
    BadgeIcon = ShieldCheck;
  }

  const headline =
    isStale
      ? 'Проверьте статус перед выходом'
      : hasAlert && safety?.topTitle
      ? safety.topTitle
      : 'Камчатка сегодня';

  const sourceLabel =
    !isStale && updatedAt
      ? `${safety?.source ?? 'КБГС РАН'} · ${formatTime(updatedAt.toISOString())}`
      : null;

  return (
    <div className="relative mx-4 mt-4 mb-0 rounded-lg overflow-hidden h-[320px] md:h-[380px]">
      <Image
        src="/images/hero/IMG_20260316_133049.jpg"
        alt="Камчатка"
        fill
        className="object-cover"
        priority
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/30 to-black/75" />

      <div className="absolute inset-0 flex flex-col justify-between p-5 md:p-6">
        {/* Top row: status badge + source chip */}
        <div className="flex items-start justify-between gap-3">
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold text-white"
            style={{ background: 'rgba(0,0,0,0.55)' }}
          >
            <BadgeIcon size={11} style={{ color: badgeColor, flexShrink: 0 }} />
            <span>{badgeLabel}</span>
          </div>
          {sourceLabel && (
            <span
              className="text-white/65 text-xs px-2.5 py-1 rounded-full whitespace-nowrap flex-shrink-0"
              style={{ background: 'rgba(0,0,0,0.40)' }}
            >
              {sourceLabel}
            </span>
          )}
        </div>

        {/* Bottom: label + headline + search */}
        <div>
          <p className="text-white/60 text-[11px] font-semibold uppercase tracking-widest mb-1.5">
            Статус дня
          </p>
          <h2 className="font-playfair text-2xl md:text-3xl text-white font-bold leading-tight mb-4 max-w-xs">
            {headline}
          </h2>

          {/* Plain HTML form — works without JS, SSR-safe */}
          <form action="/routes" method="get" className="flex items-center gap-2">
            <div
              className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-full"
              style={{
                background: 'rgba(255,255,255,0.14)',
                border: '1px solid rgba(255,255,255,0.22)',
              }}
            >
              <Search size={14} className="text-white/55 flex-shrink-0" />
              <input
                name="q"
                type="text"
                placeholder="Куда идёте?"
                className="bg-transparent outline-none flex-1 text-white placeholder:text-white/50 text-sm min-w-0"
              />
            </div>
            <button
              type="submit"
              aria-label="Найти маршрут"
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-transform hover:scale-105 active:scale-95"
              style={{ background: 'var(--accent)' }}
            >
              <ArrowRight size={16} className="text-white" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
