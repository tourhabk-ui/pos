'use client';

import { LiveFreshnessDot } from '@/components/ui/LiveFreshnessDot';
import { useNow } from '@/hooks/use-now';
import { dataFreshness } from '@/lib/home/data-freshness';

/**
 * Возраст статуса мест под сводкой дня на десктопе (12.11, «не забывай
 * десктоп»): та же метка и та же точка, что у радара на телефоне. Возраст
 * считается от настоящего `updatedAt` и сам идёт; пульс — только у свежих
 * данных, у «не знаем» — контур без заливки и слова «Обстановка недоступна».
 */
export function DeskFreshness({ updatedAt, serverNow }: { updatedAt: string | null; serverNow: string }) {
  const now = useNow(30_000, serverNow);
  const f = dataFreshness({ updatedAt, source: 'safety', now });
  return (
    <p
      className="flex items-center gap-2 px-1 text-xs"
      style={{ color: 'var(--glass-fg-muted)' }}
      data-desk-freshness={f.state}
      title="Статус мест на маршрутах"
    >
      <LiveFreshnessDot state={f.state} className="relative inline-block h-2 w-2 flex-shrink-0 rounded-full" />
      <span>Статус мест: {f.label.charAt(0).toLowerCase() + f.label.slice(1)}</span>
    </p>
  );
}
