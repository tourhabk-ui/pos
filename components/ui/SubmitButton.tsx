'use client';

/**
 * Кнопка отправки заявки, которая сама говорит исход: «Отправить» →
 * «Отправляем…» → галочка «Заявка отправлена» (12.11, «Loading to success»
 * из каталога Motion, написано заново под дизайн-систему).
 *
 * Три подписи лежат в одной клетке сетки и меняются прозрачностью и сдвигом:
 * ширина кнопки не прыгает, а читалка экрана видит только текущую подпись
 * (остальные aria-hidden). Движение — переходы Tailwind; при «уменьшить
 * движение» подписи меняются без перехода. Галочка — это `done`, который
 * форма ставит ТОЛЬКО после ответа сервера «записано»: обещать её раньше
 * значило бы сказать «отправлено» про заявку, которая могла не записаться.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Check, Loader2 } from 'lucide-react';

export type SubmitPhase = 'idle' | 'sending' | 'done';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  phase: SubmitPhase;
  idleLabel: ReactNode;
  sendingLabel?: ReactNode;
  doneLabel?: ReactNode;
}

const LAYER = 'col-start-1 row-start-1 inline-flex items-center justify-center gap-2 transition-[opacity,transform] duration-200 motion-reduce:transition-none';

function layer(visible: boolean): string {
  return `${LAYER} ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1 pointer-events-none'}`;
}

export function SubmitButton({
  phase, idleLabel, sendingLabel = 'Отправляем…', doneLabel = 'Заявка отправлена',
  className = '', disabled, type = 'submit', ...rest
}: Props) {
  return (
    <button
      type={type}
      {...rest}
      disabled={disabled || phase !== 'idle'}
      aria-busy={phase === 'sending' || undefined}
      data-phase={phase}
      // Галочка не бледнеет вместе с выключенной кнопкой: она — исход, а не запрет.
      className={`grid data-[phase=done]:!opacity-100 data-[phase=done]:!cursor-default ${className}`}
    >
      <span className={layer(phase === 'idle')} aria-hidden={phase !== 'idle' || undefined}>{idleLabel}</span>
      <span className={layer(phase === 'sending')} aria-hidden={phase !== 'sending' || undefined}>
        <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {sendingLabel}
      </span>
      <span className={layer(phase === 'done')} aria-hidden={phase !== 'done' || undefined}>
        <span
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full border-2 border-current transition-transform duration-300 motion-reduce:transition-none ${phase === 'done' ? 'scale-100' : 'scale-50'}`}
          aria-hidden="true"
        >
          <Check className="w-3 h-3" strokeWidth={3} />
        </span>
        {doneLabel}
      </span>
    </button>
  );
}
