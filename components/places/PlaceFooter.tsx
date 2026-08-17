import { ExternalLink, Send } from 'lucide-react';

interface Props {
  sourceUrl: string | null;
  sourceName: string | null;
  updatedAt: string | null;
}

/**
 * Партнёрские данные подписываются, но наружу не ведут.
 *
 * Подвал карточки места печатал «Источник: idilesom.com» кликабельной ссылкой.
 * Про этот же источник миграция 767 писала прямым текстом: реклама конкурента,
 * которую вычищали из описаний, — то есть турист, дочитавший нашу карточку,
 * получал в конце дорогу к конкуренту.
 *
 * Решение владельца 17.08: имя источника — «наши партнёры» (миграция 871).
 * Ссылка при этом обязана исчезнуть: подпись «наши партнёры» поверх ссылки на
 * чужой сайт была бы хуже прежнего — она обещает одно, а ведёт в другое.
 * Само происхождение записи никуда не делось, `source_url` остался в базе для
 * проверки фактов и авторских прав; наружу он больше не выводится.
 */
const PARTNER_SOURCE_NAME = 'наши партнёры';

export default function PlaceFooter({ sourceUrl, sourceName, updatedAt }: Props) {
  const updatedStr = updatedAt
    ? new Date(updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const partnerSource = sourceName === PARTNER_SOURCE_NAME;

  return (
    <footer className="max-w-3xl mx-auto px-4 pb-12 space-y-3 text-xs text-[var(--text-muted)]">
      <div className="border-t border-[var(--border)] pt-4 space-y-2">
        {partnerSource ? (
          <p>Источник: {PARTNER_SOURCE_NAME}</p>
        ) : sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-[var(--ocean)] transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Источник: {sourceName ?? 'ссылка'}
          </a>
        )}
        {updatedStr && (
          <p>Обновлено: {updatedStr}</p>
        )}
        <a
          href="https://t.me/kamchatka_real"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-[var(--ocean)] transition-colors"
        >
          <Send className="w-3 h-3" />
          Был тут? Поделись фото в @kamchatka_real
        </a>
      </div>
    </footer>
  );
}
