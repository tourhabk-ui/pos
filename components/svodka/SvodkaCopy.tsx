'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * Кнопка «Скопировать для мессенджера». Текст собирает сервер (`svodkaText`),
 * здесь только копирование: своего форматирования у клиента нет, чтобы
 * страница и рассылка не разошлись.
 */
export function SvodkaCopy({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      // Буфер обмена закрыт (старый браузер, встроенный вьюер) — текст остаётся
      // на странице ниже, его можно выделить рукой. Молча «скопировано» не пишем.
      setState('failed');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={copy} className="ds-btn ds-btn-primary self-start inline-flex items-center gap-2">
        {state === 'done' ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        {state === 'done' ? 'Скопировано' : 'Скопировать для WhatsApp и Telegram'}
      </button>
      {state === 'failed' && (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          Не удалось скопировать автоматически — выделите текст ниже и скопируйте вручную.
        </p>
      )}
    </div>
  );
}
