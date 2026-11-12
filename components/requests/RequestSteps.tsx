'use client';

/**
 * Где заявка сейчас — три шага с полосой (12.11, «Step progress» из каталога
 * Motion, написано заново). Шаги считает `lib/requests/request-steps`; здесь
 * только вид: полоса дорастает до текущего шага переходом ширины, точка
 * текущего шага мягко пульсирует. При «уменьшить движение» полоса сразу на
 * месте, точка стоит. Цвет — только у точек: подписи набраны текстовыми
 * токенами, тон исхода дублируется словом, а не одним цветом.
 */

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { stepsProgress, type RequestStep, type StepTone } from '@/lib/requests/request-steps';

const TONE: Record<StepTone, string> = {
  ok: 'var(--success)',
  wait: 'var(--ocean)',
  warn: 'var(--warning)',
  stop: 'var(--text-secondary)',
};

const MARK_WORDS = { done: 'пройдено', current: 'сейчас', todo: 'впереди' } as const;

export function RequestSteps({ steps }: { steps: RequestStep[] }) {
  // Полоса растёт после первого кадра: с ширины 0 до доли пройденного.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const progress = stepsProgress(steps);

  return (
    <div className="relative" data-request-steps>
      <div className="absolute left-3 right-3 top-3 h-0.5 bg-[var(--border)]" aria-hidden="true">
        <div
          className="h-full bg-[var(--ocean)] transition-[width] duration-700 ease-out motion-reduce:transition-none"
          style={{ width: `${(grown ? progress : 0) * 100}%` }}
        />
      </div>
      <ol className="relative grid grid-cols-3 gap-2" aria-label="Путь заявки">
        {steps.map((s, i) => (
          <li
            key={i}
            className="flex flex-col items-center text-center gap-1.5"
            aria-current={s.mark === 'current' ? 'step' : undefined}
          >
            <span
              className={`relative flex items-center justify-center w-6 h-6 rounded-full border-2 bg-[var(--bg-card)] ${s.mark === 'current' ? 'animate-pulse motion-reduce:animate-none' : ''}`}
              style={{ borderColor: s.mark === 'todo' ? 'var(--border)' : TONE[s.tone], color: TONE[s.tone] }}
              aria-hidden="true"
            >
              {s.mark === 'done' && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
              {s.mark === 'current' && <span className="w-2 h-2 rounded-full" style={{ background: TONE[s.tone] }} />}
            </span>
            <span className={`text-xs leading-tight ${s.mark === 'todo' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
              {s.label}
              <span className="sr-only">, {MARK_WORDS[s.mark]}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
