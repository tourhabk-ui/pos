import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import type { SafetyStatusData } from '@/components/homepage/HeroStatus';

/**
 * MobileAlertBanner — заметный баннер активной тревоги на мобильном дашборде.
 * До него мобильный юзер видел алерт КБГС только мелкой строкой в тайле
 * радара — для safety-first платформы это дыра. Данные приходят server-side
 * из getSafetyStatus() (app/page.tsx), тот же объект что у HeroStatus.
 *
 * Ничего не выдумываем: если алерта нет или данные не загрузились — баннера
 * нет (фейковый статус безопасности хуже отсутствия данных).
 */

interface MobileAlertBannerProps {
  safety: SafetyStatusData | null;
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka' });
}

export function MobileAlertBanner({ safety }: MobileAlertBannerProps) {
  if (!safety?.hasAlert) return null;

  const isDanger = safety.maxSeverity >= 3;
  const accent = isDanger ? 'var(--danger)' : 'var(--warning)';
  const updatedAt = formatTime(safety.dataUpdatedAt);

  return (
    <section
      aria-label="Активное предупреждение о безопасности"
      className="mx-4 mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4"
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      <div className="flex items-start gap-3">
        <TriangleAlert size={20} strokeWidth={1.5} style={{ color: accent }} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug text-[var(--text-primary)]">
            {safety.topTitle ?? `Активных предупреждений: ${safety.activeCount}`}
          </p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {updatedAt ? `Актуально на ${updatedAt} (КМТ)` : 'Время обновления неизвестно'} · {safety.source}
            {safety.activeCount > 1 && ` · всего: ${safety.activeCount}`}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Link
          href="/safety"
          className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-center text-sm font-medium text-[var(--text-primary)] transition-all duration-200 active:bg-[var(--bg-hover)]"
        >
          Подробнее
        </Link>
        <Link
          href="/map"
          className="flex-1 rounded-lg px-3 py-2 text-center text-sm font-medium text-white transition-all duration-200 active:opacity-90"
          style={{ background: accent }}
        >
          На карте
        </Link>
      </div>
    </section>
  );
}
