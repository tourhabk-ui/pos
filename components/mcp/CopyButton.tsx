'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/** Кнопка «Скопировать» для блоков подключения на /mcp. */
export function CopyButton({ text, label = 'Скопировать', doneLabel = 'Скопировано' }: { text: string; label?: string; doneLabel?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('failed');
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="ds-btn inline-flex items-center gap-1.5 text-xs"
      aria-live="polite"
      data-copy
    >
      {state === 'done' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {state === 'done' ? doneLabel : state === 'failed' ? 'Выделите вручную' : label}
    </button>
  );
}
