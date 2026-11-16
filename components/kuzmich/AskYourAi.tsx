import Link from 'next/link';
import { aiAskLinks } from '@/lib/kuzmich/ask-link';

/**
 * «Спросить у другого ИИ» — ссылки с готовым вопросом в ChatGPT, Claude,
 * Perplexity. Без установки и без MCP (см. lib/kuzmich/ask-link.ts).
 *
 * Второй уровень, а не главная дорога (#3468, 16.11): на карточке тура
 * ChatGPT по вопросу «стоит ли ехать» ушёл на сайты других компаний и выбрал
 * за человека. Главная дорога — Кузьмич (кнопка рядом), он отвечает по
 * каталогу Ведара. Здесь ссылки свёрнуты, вопрос привязан к странице
 * (`pageUrl`), и человеку сказано, что чужой ИИ может уйти на другие сайты.
 */
export default function AskYourAi({
  question,
  pageUrl,
  className = '',
}: {
  question: string;
  pageUrl?: string | null;
  className?: string;
}) {
  const links = aiAskLinks(question, pageUrl);
  return (
    <details className={`ds-card p-4 ${className}`}>
      <summary className="cursor-pointer min-h-[44px] flex items-center text-sm font-medium text-[var(--text-primary)]">
        Спросить у другого ИИ
      </summary>
      <p className="text-sm text-[var(--text-secondary)] mt-2 mb-3">
        Откроется ваш ИИ с вопросом об этой странице. Он может уйти на другие сайты
        и отвечает не по каталогу Ведара. Цены и свободные места называет только
        оператор в ответе на заявку.
      </p>
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <a key={l.id} href={l.href} target="_blank" rel="noopener noreferrer nofollow"
             data-ai-ask={l.id}
             className="inline-flex items-center min-h-[44px] px-4 rounded-full border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
            {l.label}
          </a>
        ))}
      </div>
      <p className="text-xs text-[var(--text-secondary)] mt-3">
        Пользуетесь Claude, Cursor или ChatGPT с коннекторами? <Link href="/mcp" className="underline">Подключите Ведар как MCP</Link> — тогда ИИ отвечает по данным Ведара.
      </p>
    </details>
  );
}
