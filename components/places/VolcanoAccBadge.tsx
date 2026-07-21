'use client';

import { Mountain, ExternalLink } from 'lucide-react';
import { ACC_META, type AccColor } from '@/lib/services/safety/kvert-vona';
import type { VolcanoAccStatus } from '@/components/places/types';

/**
 * Бейдж авиационного цветового кода (ACC) вулкана по данным KVERT.
 * Цвет — уровень активности вулкана (зелёный→красный). Честно поясняем: код
 * рассчитан для авиации (риск пепла), но отражает и общий уровень активности.
 * Не подменяет решение идти/не идти — это индикатор, а не разрешение.
 */
export default function VolcanoAccBadge({ status }: { status: VolcanoAccStatus }) {
  const color = (['green', 'yellow', 'orange', 'red'].includes(status.colorCode)
    ? status.colorCode
    : 'unassigned') as AccColor;
  const meta = ACC_META[color];

  const observed = status.observedAt
    ? new Date(status.observedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  return (
    <div className="max-w-3xl mx-auto px-4 pt-3">
      <div
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4"
        style={{ borderLeftWidth: '4px', borderLeftColor: meta.token }}
      >
        <div className="flex items-center gap-2.5 mb-2">
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-full flex-shrink-0"
            style={{ backgroundColor: meta.token }}
            aria-hidden
          >
            <Mountain className="w-4 h-4 text-white" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
              Авиационный цветовой код · KVERT
            </p>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {meta.short} — {meta.label}
            </p>
          </div>
        </div>

        {status.summary && (
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3">{status.summary}</p>
        )}

        <div className="flex items-center gap-3 flex-wrap mt-2 text-xs text-[var(--text-muted)]">
          {status.ashHeightM != null && <span>Пепел до {(status.ashHeightM / 1000).toFixed(1)} км</span>}
          {observed && <span>Наблюдение: {observed}</span>}
          <a
            href={status.sourceUrl || 'http://www.kscnet.ru/ivs/kvert/'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[var(--ocean)] hover:underline"
          >
            KVERT <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        <p className="text-[11px] text-[var(--text-muted)] mt-2 leading-snug">
          Код рассчитан для авиации (риск выброса пепла) и отражает уровень активности вулкана.
          Актуальную сводку сверяйте на KVERT перед выходом.
        </p>
      </div>
    </div>
  );
}
