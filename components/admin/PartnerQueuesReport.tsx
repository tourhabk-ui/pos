'use client';

import { useEffect, useState } from 'react';
import { queueLines, type PartnerQueues, type QueueLine, type QueueTone } from '@/lib/admin/partner-queue-lines';

/**
 * Отчёт очередей партнёрского контура на экране «Операторы» (план готовности
 * 23.11, этап 6). Только числа и слова: что ждёт администратора и что ждёт
 * партнёра. Три исхода чтения: числа, «не прочитано» у отдельного числа и
 * «отчёт не загрузился» у всего блока — пустоты, похожей на «очередей нет»,
 * нет.
 */
type State =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; lines: QueueLine[] };

const TONE: Record<QueueTone, string> = {
  calm: 'text-[var(--text-primary)]',
  attention: 'text-[var(--warning)]',
  unknown: 'text-[var(--text-muted)]',
};

export function PartnerQueuesReport() {
  const [view, setView] = useState<State>({ state: 'loading' });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/admin/partners/queues');
        const json = await res.json().catch(() => null) as { success?: boolean; data?: PartnerQueues; error?: string } | null;
        if (!alive) return;
        if (!res.ok || !json?.success || !json.data) {
          setView({ state: 'failed', error: json?.error ?? `Отчёт очередей не загрузился (код ${res.status})` });
          return;
        }
        setView({ state: 'ready', lines: queueLines(json.data) });
      } catch {
        if (alive) setView({ state: 'failed', error: 'Отчёт очередей не загрузился' });
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <section aria-label="Очереди партнёров" className="ds-card mb-4" data-testid="partner-queues">
      <h2 className="text-sm font-bold text-[var(--text-primary)] mb-3">Очереди партнёров</h2>
      {view.state === 'loading' && <div className="ds-skeleton h-16" aria-busy="true" />}
      {view.state === 'failed' && <p role="alert" className="text-sm text-[var(--danger)]">{view.error}</p>}
      {view.state === 'ready' && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          {view.lines.map((line) => (
            <li key={line.key} data-key={line.key} data-tone={line.tone}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-[var(--text-secondary)]">
                  {line.href
                    ? <a href={line.href} className="text-[var(--ocean)] hover:underline">{line.label}</a>
                    : line.label}
                </span>
                <span className={`text-sm font-bold ${TONE[line.tone]}`}>{line.value}</span>
              </div>
              <p className="text-xs text-[var(--text-muted)]">{line.hint}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
