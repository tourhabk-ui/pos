'use client';

import Link from 'next/link';
import { chatBlocks, chatLinkChunks, type ChatChunk } from '@/lib/kuzmich/chat-links';

function Chunks({ text }: { text: string }) {
  return (
    <>
      {chatLinkChunks(text).map((c: ChatChunk, i) => {
        if (!c.href) return <span key={i}>{c.text}</span>;
        const cls = 'underline underline-offset-2 break-all text-[var(--ocean)]';
        return c.external
          ? <a key={i} href={c.href} target="_blank" rel="noopener noreferrer nofollow" className={cls}>{c.text}</a>
          : <Link key={i} href={c.href} className={cls}>{c.text}</Link>;
      })}
    </>
  );
}

/** Текст ответа Кузьмича: ссылки кликабельны, пункты «- » и «1.» — списком. */
export default function ChatText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      {chatBlocks(text).map((block, i) => (
        block.kind === 'list'
          ? (
            <ul key={i} className="list-disc pl-5 flex flex-col gap-1">
              {block.items.map((item, j) => <li key={j}><Chunks text={item} /></li>)}
            </ul>
          )
          : <p key={i}><Chunks text={block.text} /></p>
      ))}
    </div>
  );
}
