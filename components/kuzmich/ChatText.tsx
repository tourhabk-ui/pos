'use client';

import Link from 'next/link';
import { chatLinkChunks } from '@/lib/kuzmich/chat-links';

const LINK = 'underline underline-offset-2 break-all text-[var(--ocean)]';

/** Строка «День 1 — …» — подзаголовок программы, а не абзац сплошного текста. */
function isDayHeading(line: string): boolean {
  return /^День\s+\d+\b/.test(line.trim());
}

function LineChunks({ line }: { line: string }) {
  return (
    <>
      {chatLinkChunks(line).map((c, i) => {
        if (!c.href) return <span key={i}>{c.text}</span>;
        return c.external
          ? <a key={i} href={c.href} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>{c.text}</a>
          : <Link key={i} href={c.href} className={LINK}>{c.text}</Link>;
      })}
    </>
  );
}

/**
 * Текст ответа Кузьмича с кликабельными ссылками (lib/kuzmich/chat-links).
 * Дни программы — отдельные строки-подзаголовки: модель ставит «День N —»
 * с новой строки, здесь строка становится заголовком, а не стеной текста.
 */
export default function ChatText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, li) => (
        <span
          key={li}
          className={isDayHeading(line) ? 'block font-semibold mt-3 first:mt-0' : 'block min-h-[1.25em]'}
        >
          {line === '' ? '\u00a0' : <LineChunks line={line} />}
        </span>
      ))}
    </>
  );
}
