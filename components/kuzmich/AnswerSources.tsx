/**
 * Источники под ответом Кузьмича (#3412, п. 1): что проверено за этот ход и
 * страница Ведара, если она есть. Список строит сервер из вывода инструментов
 * (lib/kuzmich/answer-sources) — модель его не пишет.
 */
import Link from 'next/link';
import type { AnswerSource } from '@/lib/kuzmich/answer-sources';

export default function AnswerSources({ sources, compact = false }: { sources?: readonly AnswerSource[]; compact?: boolean }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div data-answer="sources" className={`${compact ? 'text-[11px]' : 'text-xs'} text-[var(--text-muted)]`}>
      <span className="font-medium text-[var(--text-secondary)]">Источники: </span>
      {sources.map((s, i) => (
        <span key={`${s.title}|${s.href ?? ''}`}>
          {i > 0 && ' · '}
          {s.href
            ? <Link href={s.href} className="text-[var(--ocean)] hover:underline">{s.title}</Link>
            : s.title}
        </span>
      ))}
    </div>
  );
}
