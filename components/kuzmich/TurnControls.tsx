'use client';
/**
 * «Остановить» и «Ещё раз» в веб-чате Кузьмича (#3412, п. 3). Правила —
 * lib/kuzmich/turn-control; здесь только кнопки, одни на /kuzmich и в виджете.
 */
import { RotateCcw, Square } from 'lucide-react';
import { canStopTurn, retryQuestion, STOP_LOCKED_TEXT, type TurnMessage } from '@/lib/kuzmich/turn-control';

export function StopTurnButton({ question, onStop, compact = false }: { question: string; onStop: () => void; compact?: boolean }) {
  if (!canStopTurn(question)) {
    return <p className={`${compact ? 'text-[11px]' : 'text-xs'} text-[var(--text-muted)]`} data-turn="stop-locked">{STOP_LOCKED_TEXT}</p>;
  }
  return (
    <button type="button" onClick={onStop} data-turn="stop"
      className={`inline-flex items-center gap-1.5 ${compact ? 'text-[11px] min-h-[32px]' : 'text-xs min-h-[44px]'} text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors`}>
      <Square size={compact ? 10 : 12} aria-hidden />
      Остановить
    </button>
  );
}

export function RetryTurnButton({ messages, onRetry, compact = false }: { messages: readonly TurnMessage[]; onRetry: (q: string) => void; compact?: boolean }) {
  const q = retryQuestion(messages);
  if (!q) return null;
  return (
    <button type="button" onClick={() => onRetry(q)} data-turn="retry"
      className={`self-start inline-flex items-center gap-1.5 ${compact ? 'text-[11px] min-h-[32px]' : 'text-xs min-h-[44px]'} text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors`}>
      <RotateCcw size={compact ? 10 : 12} aria-hidden />
      Ещё раз
    </button>
  );
}
