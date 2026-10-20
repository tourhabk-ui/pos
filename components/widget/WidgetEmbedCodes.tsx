'use client';

/**
 * Коды вставки виджетов Ведара — чат и кнопка заявки (аудит 15.10, находка
 * WID-screens, W7). Один компонент на кабинет оператора и карточку в админке:
 * коды строит lib/embed/widget-snippets, и разойтись между экранами они не
 * могут. До 15.10 админка показывала только код формы, а кода чата не было
 * нигде.
 *
 * Копирование не глушит отказ (§4.0): буфер обмена бывает закрыт политикой
 * браузера, и тогда человек видит «не скопировалось», а не зелёную галочку.
 */
import { useState } from 'react';
import { Check, Copy, MessageCircle, FileText } from 'lucide-react';
import { widgetSnippets } from '@/lib/embed/widget-snippets';

type Kind = 'chat' | 'form';

const BLOCKS: Array<{ kind: Kind; title: string; text: string; Icon: typeof MessageCircle }> = [
  {
    kind: 'chat',
    title: 'Чат с Кузьмичом',
    text: 'Кнопка в углу сайта открывает чат. Он показывает только ваши туры, а оставить заявку предлагает формой — с телефоном и согласием.',
    Icon: MessageCircle,
  },
  {
    kind: 'form',
    title: 'Кнопка заявки',
    text: 'Кнопка открывает форму заявки. Заявка приходит вам в кабинет («Заявки с сайта») и в мессенджер, если он подключён.',
    Icon: FileText,
  },
];

export function WidgetEmbedCodes({ slug, compact = false }: { slug: string | null; compact?: boolean }) {
  const snippets = widgetSnippets(slug);
  const [copied, setCopied] = useState<Kind | null>(null);
  const [copyError, setCopyError] = useState<Kind | null>(null);

  if (!snippets) {
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        Код не собрать: у компании нет короткого адреса (slug) из латинских букв, цифр и дефиса.
        Его заводит администратор Ведара.
      </p>
    );
  }

  async function copy(kind: Kind) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(snippets![kind]);
      setCopied(kind);
      setTimeout(() => setCopied((k) => (k === kind ? null : k)), 2000);
    } catch {
      setCopied(null);
      setCopyError(kind);
    }
  }

  return (
    <div className={compact ? 'space-y-2' : 'space-y-4'}>
      {BLOCKS.map(({ kind, title, text, Icon }) => (
        <div key={kind}>
          <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
            <Icon className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden />
            {title}
          </div>
          {!compact && <p className="text-xs text-[var(--text-secondary)] mt-0.5 mb-1.5">{text}</p>}
          <div className="flex items-start gap-1.5 mt-1">
            <code
              className={`flex-1 min-w-0 text-[11px] bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-secondary)] select-all break-all ${compact ? 'truncate' : ''}`}
              aria-label={`Код вставки: ${title}`}
            >
              {snippets[kind]}
            </code>
            <button
              type="button"
              onClick={() => void copy(kind)}
              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] rounded transition-colors shrink-0"
              aria-label={`Скопировать код: ${title}`}
              title="Скопировать код"
            >
              {copied === kind ? <Check className="w-3.5 h-3.5 text-[var(--success)]" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
            </button>
          </div>
          {copyError === kind && (
            <p className="text-xs text-[var(--danger)] mt-1" role="alert">
              Не скопировалось — выделите код и скопируйте вручную.
            </p>
          )}
        </div>
      ))}
      {!compact && (
        <p className="text-xs text-[var(--text-muted)]">
          Код вставляется перед закрывающим тегом &lt;/body&gt; на каждой странице, где нужна кнопка
          (в &lt;head&gt; — тоже можно: у скриптов стоит defer). Можно поставить один из двух кодов или оба.
        </p>
      )}
    </div>
  );
}
