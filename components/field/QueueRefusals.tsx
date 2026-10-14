'use client';

/**
 * Записи офлайн-очереди, которые сервер не принял (#2448).
 *
 * Сами они больше не уйдут: повтор того же самого получит тот же отказ, а
 * держать ими очередь нельзя (lib/offline/outbox). Решает человек —
 * исправить, отправить снова или удалить. До 14.10 такая запись молча стояла
 * первой в очереди, а экран обещал «уйдёт само».
 *
 * Предупреждение узнаётся кромкой цвета предупреждения, текст — токенами
 * темы (CLAUDE.md §2). Общий для экрана маршрута и формы /field-check: два
 * полевых контура говорят об отказе одними словами.
 */
import { AlertTriangle } from 'lucide-react';

export interface RefusalAction {
  label: string;
  onPress: () => void;
}

export interface RefusalRow {
  id: string;
  title: string;
  excerpt?: string | null;
  /** Слова сервера: почему не принято. */
  reason: string;
  /** Снимки записи (base64 без префикса): на телефоне их может не быть больше нигде. */
  photos?: string[];
  actions: RefusalAction[];
}

export function QueueRefusals({ rows }: { rows: RefusalRow[] }) {
  if (rows.length === 0) return null;
  const heading = `Сервер не принял: ${rows.length}`;
  return (
    <section
      aria-label={heading}
      className="rounded-lg p-3 flex flex-col gap-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--warning)' }}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
        {heading}
      </h3>
      <p className="text-xs text-[var(--text-secondary)]">
        Сами они не уйдут: исправьте или удалите.
      </p>
      <ul className="flex flex-col gap-3">
        {rows.map(row => (
          <li key={row.id} className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-[var(--text-primary)]">{row.title}</p>
            {row.excerpt ? (
              <p className="text-sm text-[var(--text-secondary)] line-clamp-2">{row.excerpt}</p>
            ) : null}
            <p className="text-sm text-[var(--text-secondary)]">Причина: {row.reason}</p>
            {row.photos && row.photos.length > 0 ? (
              <div className="flex gap-2">
                {row.photos.map((p, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={`data:image/jpeg;base64,${p}`}
                    alt={`Снимок ${i + 1}`}
                    className="w-12 h-12 rounded-lg object-cover"
                  />
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {row.actions.map(a => (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onPress}
                  className="ds-btn ds-btn-secondary text-sm"
                  style={{ minHeight: 44 }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
