'use client';

/**
 * «Кузьмич думает» волной по буквам вместо крутилки (12.11, «Thinking text»
 * из каталога Motion, написано заново).
 *
 * Шагов работы модели здесь нет намеренно: ответ Кузьмича не идёт по ходу, и
 * шаги, которых виджет не получает, были бы выдумкой (правило честности, §0).
 * Правду сказать можно одну — сколько ждём: через `slowAfterMs` подпись
 * добавляет «отвечает дольше обычного», потому что запасной путь модели
 * отвечает десятки секунд (§8), а немая волна в это время читается как зависание.
 *
 * Волна — стандартный `animate-pulse` Tailwind с задержкой по букве; при
 * «уменьшить движение» буквы стоят. Читалке экрана — одна фраза, не буквы.
 */

import { useEffect, useState } from 'react';

interface Props {
  text?: string;
  slowText?: string;
  slowAfterMs?: number;
  className?: string;
}

export function ThinkingText({
  text = 'Кузьмич думает',
  slowText = 'отвечает дольше обычного',
  slowAfterMs = 8000,
  className = '',
}: Props) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(t);
  }, [slowAfterMs]);

  const label = slow ? `${text}, ${slowText}` : text;
  return (
    <span role="status" aria-label={label} className={`inline-flex flex-wrap items-baseline ${className}`}>
      <span aria-hidden="true" className="inline-flex">
        {Array.from(text).map((ch, i) => (
          <span
            key={i}
            className="animate-pulse motion-reduce:animate-none whitespace-pre"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            {ch}
          </span>
        ))}
      </span>
      {slow && <span aria-hidden="true" className="ml-1">— {slowText}</span>}
    </span>
  );
}
