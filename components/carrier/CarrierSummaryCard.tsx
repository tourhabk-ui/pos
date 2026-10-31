'use client';

/**
 * Сводка перевозчика в кабинете на сайте (#2862 этап D): те же строки, что в
 * чате (carrierSummaryLines) — одно правило слов на обе поверхности. Три
 * исхода чтения: читаем / есть / не прочиталось; внутри — блок, который не
 * прочитался, назван так, а не нулём.
 */
import { AlertCircle, BarChart3 } from 'lucide-react';
import { carrierSummaryLines, type CarrierSummary } from '@/lib/transfers/carrier-summary';

export const CARRIER_SUMMARY_API = '/api/hub/carrier/summary';

export type SummaryLoad = { state: 'loading' } | { state: 'ok'; summary: CarrierSummary } | { state: 'failed'; message: string };

export function CarrierSummaryCard({ load }: { load: SummaryLoad }) {
  return (
    <section data-testid="carrier-summary">
      <h2 className="ds-h2 mb-1 flex items-center gap-2"><BarChart3 size={16} /> Сводка</h2>
      {load.state === 'loading' && <p className="text-sm text-[var(--text-muted)]">Считаем…</p>}
      {load.state === 'failed' && (
        <div className="ds-card p-4 flex items-start gap-2 border-[var(--warning)]">
          <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
          <p className="text-sm text-[var(--text-secondary)]">Не смогли прочитать сводку: {load.message}. Это не значит, что заявок не было.</p>
        </div>
      )}
      {load.state === 'ok' && (
        <ul className="ds-card p-4 flex flex-col gap-1">
          {carrierSummaryLines(load.summary).map((line) => (
            <li key={line} className="text-sm text-[var(--text-primary)]">{line}</li>
          ))}
          <li className="text-xs text-[var(--text-muted)] mt-1">Время — Камчатка. Медиана — половина заявок получила ответ быстрее этого срока.</li>
        </ul>
      )}
    </section>
  );
}
