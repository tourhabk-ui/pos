import Link from 'next/link';
import { aiAskLinks } from '@/lib/kuzmich/ask-link';

/**
 * «Спросите про Ведар у своего ИИ» — ссылки с готовым вопросом в ChatGPT,
 * Claude, Perplexity. Без установки и без MCP (см. lib/kuzmich/ask-link.ts).
 * Для продвинутых — ссылка на /mcp, но не в главной дороге.
 */
export default function AskYourAi({ question, className = '' }: { question: string; className?: string }) {
  const links = aiAskLinks(question);
  return (
    <section aria-labelledby="ask-your-ai-title" className={`ds-card p-5 ${className}`}>
      <h2 id="ask-your-ai-title" className="font-semibold text-[var(--text-primary)] text-base mb-1">
        Спросите про Ведар у своего ИИ
      </h2>
      <p className="text-sm text-[var(--text-secondary)] mb-3">
        Откроется ваш ИИ с готовым вопросом — ничего подключать не нужно.
      </p>
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <a key={l.id} href={l.href} target="_blank" rel="noopener noreferrer nofollow"
             data-ai-ask={l.id}
             className="inline-flex items-center min-h-[44px] px-4 rounded-full border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]">
            {l.label}
          </a>
        ))}
      </div>
      <p className="text-xs text-[var(--text-secondary)] mt-3">
        Пользуетесь Claude, Cursor или ChatGPT с коннекторами? <Link href="/mcp" className="underline">Подключите Ведар как MCP</Link>.
      </p>
    </section>
  );
}
