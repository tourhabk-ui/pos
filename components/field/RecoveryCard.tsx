'use client';

/**
 * Карточка восстановления — смена главной задачи, а не модальное окно.
 *
 * Она заметная, но не паническая, и никогда не закрывает компас с
 * дистанцией: человеку, который сбился, приборы нужны больше обычного.
 * «Продолжить намеренно» приглушает карточку до одной строки, но состояние
 * не отменяет — уйти с линии можно осознанно, а вот забыть об этом нельзя.
 */

import { AlertTriangle, ChevronRight, Info } from 'lucide-react';
import type { RecoveryState } from '@/lib/on-route/recovery';

export interface RecoveryCardProps {
  state: RecoveryState;
  /** Пользователь нажал «Продолжить намеренно». */
  muted: boolean;
  onMute: () => void;
  onUnmute: () => void;
  onPrimary: (kind: NonNullable<RecoveryState['primary']>['kind']) => void;
}

export function RecoveryCard({ state, muted, onMute, onUnmute, onPrimary }: RecoveryCardProps) {
  if (state.kind === 'none') return null;

  const color = state.tone === 'warn' ? 'var(--warning)' : 'var(--ocean)';

  // Приглушённый вид: одна строка, состояние по-прежнему названо.
  if (muted) {
    return (
      <button onClick={onUnmute}
        className="w-full flex items-center gap-2 px-4 py-2 rounded-xl text-left"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <Info className="w-3.5 h-3.5 shrink-0" style={{ color }} />
        <span className="text-xs flex-1" style={{ color: 'var(--text-muted)' }}>{state.title}</span>
        <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl p-4"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
      }}>
      <div className="flex items-start gap-2 mb-1.5">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color }} />
        <p className="text-sm font-semibold flex-1" style={{ color }}>{state.title}</p>
      </div>
      <p className="text-xs leading-snug mb-3" style={{ color: 'var(--text-secondary)' }}>
        {state.text}
      </p>
      <div className="flex gap-2">
        {state.primary && (
          <button onClick={() => onPrimary(state.primary!.kind)}
            className="flex-1 text-xs font-bold px-3 py-2.5 rounded-lg"
            style={{
              background: `color-mix(in srgb, ${color} 14%, transparent)`,
              color,
              border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
            }}>
            {state.primary.label}
          </button>
        )}
        {state.dismissible && (
          <button onClick={onMute}
            className="flex-1 text-xs font-semibold px-3 py-2.5 rounded-lg"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
            Продолжить намеренно
          </button>
        )}
      </div>
    </div>
  );
}
