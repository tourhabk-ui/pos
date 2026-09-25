import Link from 'next/link';
import { ChevronRight, ChevronDown, Info, MessageSquare } from 'lucide-react';
import { SUPPORT, type HelpArticle, type HelpBlock } from '@/lib/help/content';

/**
 * Страница справки из lib/help/content.ts — серверная, без клиентского JS:
 * вопросы-ответы раскрываются нативным <details>, это работает и без
 * загруженного скрипта (слабая связь в поле).
 */

function Block({ block }: { block: HelpBlock }) {
  switch (block.kind) {
    case 'p':
      return <p className="text-[var(--text-secondary)] leading-relaxed">{block.text}</p>;
    case 'steps':
      return (
        <ol className="space-y-3">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-7 h-7 rounded-full bg-[var(--accent)] text-[var(--on-accent)] flex items-center justify-center text-sm font-bold flex-shrink-0">
                {i + 1}
              </span>
              <span className="text-[var(--text-secondary)] leading-relaxed pt-0.5">{item}</span>
            </li>
          ))}
        </ol>
      );
    case 'bullets':
      return (
        <ul className="list-disc pl-5 space-y-2 text-[var(--text-secondary)] leading-relaxed">
          {block.items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-hover)]">
              <tr>
                {block.head.map((h) => (
                  <th key={h} className="text-left font-semibold text-[var(--text-primary)] px-4 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map(([a, b]) => (
                <tr key={a} className="border-t border-[var(--border)] align-top">
                  <td className="px-4 py-2 font-medium text-[var(--text-primary)] whitespace-nowrap">{a}</td>
                  <td className="px-4 py-2 text-[var(--text-secondary)]">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'note':
      return (
        <div className="flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <Info size={18} className="text-[var(--ocean)] flex-shrink-0 mt-0.5" />
          <p className="text-sm text-[var(--text-primary)] leading-relaxed">{block.text}</p>
        </div>
      );
  }
}

export function SupportCard() {
  return (
    <div className="ds-card p-5 flex items-start gap-4">
      <MessageSquare size={22} className="text-[var(--text-secondary)] flex-shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-medium text-[var(--text-primary)]">Не нашли ответ?</p>
        <p className="text-[var(--text-secondary)]">
          Напишите на{' '}
          <a href={`mailto:${SUPPORT.email}`} className="text-[var(--ocean)] hover:underline">{SUPPORT.email}</a>{' '}
          или в Telegram{' '}
          <a href={`https://t.me/${SUPPORT.telegram}`} className="text-[var(--ocean)] hover:underline">@{SUPPORT.telegram}</a>.
          {' '}При опасности — не поддержка, а 112 или кнопка SOS в шапке сайта.
        </p>
      </div>
    </div>
  );
}

export default function HelpArticleView({ article }: { article: HelpArticle }) {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <div className="bg-[var(--bg-card)] border-b border-[var(--border)]">
        <div className="max-w-3xl mx-auto px-4 py-10">
          <Link href="/help" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] mb-5 transition-colors">
            <ChevronRight size={14} className="rotate-180" /> Центр помощи
          </Link>
          <p className="text-sm font-medium text-[var(--accent)] uppercase tracking-wider mb-2">{article.audience}</p>
          <h1 className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            {article.title}
          </h1>
          <p className="text-[var(--text-secondary)] text-lg">{article.lead}</p>
          <nav aria-label="Разделы" className="flex flex-wrap gap-2 mt-6">
            {article.sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="ds-badge hover:bg-[var(--bg-hover)] transition-colors">{s.title}</a>
            ))}
            {article.faq.length > 0 && (
              <a href="#faq" className="ds-badge hover:bg-[var(--bg-hover)] transition-colors">Частые вопросы</a>
            )}
          </nav>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-10 space-y-10">
        {article.sections.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-24 space-y-4">
            <h2 className="ds-h2">{s.title}</h2>
            {s.blocks.map((b, i) => <Block key={i} block={b} />)}
          </section>
        ))}

        {article.faq.length > 0 && (
          <section id="faq" className="scroll-mt-24 space-y-3">
            <h2 className="ds-h2">Частые вопросы</h2>
            {article.faq.map((f) => (
              <details key={f.q} className="ds-card group">
                <summary className="flex items-center justify-between gap-3 p-4 cursor-pointer list-none font-medium text-[var(--text-primary)]">
                  {f.q}
                  <ChevronDown size={18} className="text-[var(--text-secondary)] transition-transform group-open:rotate-180 flex-shrink-0" />
                </summary>
                <p className="px-4 pb-4 text-sm text-[var(--text-secondary)] leading-relaxed">{f.a}</p>
              </details>
            ))}
          </section>
        )}

        <SupportCard />
      </div>
    </div>
  );
}
