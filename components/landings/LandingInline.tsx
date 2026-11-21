/**
 * Inline-узлы текста посадочной (lib/articles/markdown) → элементы React.
 * Та же отрисовка, что у ArticleMarkdown: ссылки на сайт — next/link, чужие —
 * новой вкладкой с noopener, сноска [n] ведёт к пункту n «Источников».
 * Отдельный файл, чтобы шаблон посадочной не правил общий рендер статей.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Inline } from '@/lib/articles/markdown';

export function renderLandingInline(nodes: Inline[], keyBase: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyBase}.${i}`;
    switch (n.t) {
      case 'text': return n.v;
      case 'strong': return <strong key={key}>{renderLandingInline(n.c, key)}</strong>;
      case 'em': return <em key={key}>{renderLandingInline(n.c, key)}</em>;
      case 'ref':
        return (
          <sup key={key} className="inline-block">
            <a href={`#source-${n.n}`} className="text-[var(--ocean)] no-underline inline-flex items-center justify-center min-w-6 min-h-6 px-1 mx-0.5 text-[13px] leading-none">[{n.n}]</a>
          </sup>
        );
      case 'link':
        return n.href.startsWith('/')
          ? <Link key={key} href={n.href} className="text-[var(--ocean)] underline underline-offset-2">{renderLandingInline(n.c, key)}</Link>
          : (
            <a key={key} href={n.href} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] underline underline-offset-2 break-words">
              {renderLandingInline(n.c, key)}
            </a>
          );
    }
  });
}
