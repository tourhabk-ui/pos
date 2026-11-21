/**
 * Тело переписанной статьи (lib/articles/markdown). Без хуков и без
 * dangerouslySetInnerHTML: всё — элементы React, текст экранируется.
 * Ссылки на свой сайт — next/link с относительным путём, чужие — новой
 * вкладкой с noopener. Сноска [n] ведёт к пункту n списка «Источники».
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Block, Inline } from '@/lib/articles/markdown';

function renderInline(nodes: Inline[], keyBase: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyBase}.${i}`;
    switch (n.t) {
      case 'text': return n.v;
      case 'strong': return <strong key={key}>{renderInline(n.c, key)}</strong>;
      case 'em': return <em key={key}>{renderInline(n.c, key)}</em>;
      case 'ref':
        return (
          <sup key={key} className="inline-block">
            <a href={`#source-${n.n}`} className="text-[var(--ocean)] no-underline inline-flex items-center justify-center min-w-6 min-h-6 px-1 mx-0.5 text-[13px] leading-none">[{n.n}]</a>
          </sup>
        );
      case 'link':
        return n.href.startsWith('/')
          ? <Link key={key} href={n.href} className="text-[var(--ocean)] underline underline-offset-2">{renderInline(n.c, key)}</Link>
          : (
            <a key={key} href={n.href} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] underline underline-offset-2 break-words">
              {renderInline(n.c, key)}
            </a>
          );
    }
  });
}

export function ArticleMarkdown({ blocks }: { blocks: Block[] }) {
  // Нумерованный список сразу после «## Источники» — якоря для сносок [n].
  let inSources = false;
  return (
    <div className="space-y-4">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case 'h2':
            inSources = /^источники$/i.test(b.text);
            return <h2 key={k} className="ds-h2 pt-4" style={{ fontFamily: 'var(--font-playfair)' }}>{renderInline(b.c, k)}</h2>;
          case 'h3':
            return <h3 key={k} className="text-lg font-semibold pt-2">{renderInline(b.c, k)}</h3>;
          case 'p':
            return <p key={k} className="text-[var(--text-primary)] leading-relaxed">{renderInline(b.c, k)}</p>;
          case 'ul':
            return (
              <ul key={k} className="list-disc pl-6 space-y-1 text-[var(--text-primary)] leading-relaxed">
                {b.items.map((it, j) => <li key={j}>{renderInline(it, `${k}.${j}`)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k} className={`list-decimal pl-6 space-y-1 leading-relaxed ${inSources ? 'text-sm text-[var(--text-secondary)] break-words [overflow-wrap:anywhere]' : 'text-[var(--text-primary)]'}`}>
                {b.items.map((it, j) => (
                  <li key={j} id={inSources ? `source-${j + 1}` : undefined}>{renderInline(it, `${k}.${j}`)}</li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={k} className="relative" data-table-scroll="">
                <p className="sm:hidden text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Таблица прокручивается вправо</p>
                <div className="overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)] sm:[mask-image:none]">
                <table className="w-max min-w-full text-sm border-collapse">
                  {b.head.length > 0 && (
                    <thead>
                      <tr>{b.head.map((c, j) => <th key={j} className="text-left font-semibold border-b border-[var(--border)] py-2 pr-3">{renderInline(c, `${k}.h${j}`)}</th>)}</tr>
                    </thead>
                  )}
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, x) => <td key={x} className="border-b border-[var(--border)] py-2 pr-3 align-top">{renderInline(c, `${k}.${j}.${x}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            );
          case 'qa':
            return (
              <div key={k}>
                <h3 className="font-semibold text-[var(--text-primary)] mb-1">{renderInline(b.q, `${k}.q`)}</h3>
                {b.a.map((p, j) => <p key={j} className="text-[var(--text-primary)] leading-relaxed">{renderInline(p, `${k}.a${j}`)}</p>)}
              </div>
            );
        }
      })}
    </div>
  );
}
