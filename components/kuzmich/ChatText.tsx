'use client';

import Link from 'next/link';
import { chatLinkChunks } from '@/lib/kuzmich/chat-links';

/** Текст ответа Кузьмича с кликабельными ссылками (lib/kuzmich/chat-links). */
export default function ChatText({ text }: { text: string }) {
  return (
    <>
      {chatLinkChunks(text).map((c, i) => {
        if (!c.href) return <span key={i}>{c.text}</span>;
        const cls = 'underline underline-offset-2 break-all text-[var(--ocean)]';
        return c.external
          ? <a key={i} href={c.href} target="_blank" rel="noopener noreferrer nofollow" className={cls}>{c.text}</a>
          : <Link key={i} href={c.href} className={cls}>{c.text}</Link>;
      })}
    </>
  );
}
