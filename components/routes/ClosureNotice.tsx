import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { RouteClosure } from '@/lib/routes/closures';

/** Плашка о закрытии маршрута — в серверном HTML, с источниками и датой. */
export function ClosureNotice({ closure }: { closure: RouteClosure }) {
  return (
    <section
      role="alert"
      data-route-closure
      className="rounded-xl p-4 flex gap-3"
      style={{ background: 'rgba(192, 57, 43, 0.08)', border: '1px solid rgba(192, 57, 43, 0.35)' }}
    >
      <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: '#B03A2E' }} aria-hidden />
      <div className="space-y-1.5 text-sm">
        <p className="font-semibold" style={{ color: '#8E2B21' }}>{closure.title}</p>
        <p style={{ color: 'var(--text-primary)' }}>{closure.text}</p>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          Проверено на {closure.asOf}. Источники:{' '}
          {closure.sources.map((s, i) => (
            <React.Fragment key={s.url}>
              {i > 0 && ', '}
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">{s.label}</a>
            </React.Fragment>
          ))}
        </p>
      </div>
    </section>
  );
}
