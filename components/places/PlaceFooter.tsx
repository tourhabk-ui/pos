import { ExternalLink, Send } from 'lucide-react';

interface Props {
  sourceUrl: string | null;
  sourceName: string | null;
  updatedAt: string | null;
}

/**
 * Сторонний источник подписывается родом, но наружу не ведёт.
 *
 * Подвал карточки места печатал «Источник: idilesom.com» кликабельной ссылкой.
 * Про этот же источник миграция 767 писала прямым текстом: реклама конкурента,
 * которую вычищали из описаний, — то есть турист, дочитавший нашу карточку,
 * получал в конце дорогу к конкуренту.
 *
 * Решение владельца 17.08: имени поставщика на экране нет вовсе (миграция
 * 871). Подменять его другим именем было нельзя — «наши партнёры» утверждало
 * бы отношения, которых нет; про этот источник 767 говорит «конкурент».
 * Ссылка тоже исчезает: подпись без имени поверх ссылки на чужой сайт обещает
 * одно, а ведёт в другое.
 * Само происхождение записи никуда не делось, `source_url` остался в базе для
 * проверки фактов и авторских прав; наружу он больше не выводится.
 */
const EXTERNAL_SOURCE_NAME = 'сторонний источник';

export default function PlaceFooter({ sourceUrl, sourceName, updatedAt }: Props) {
  const updatedStr = updatedAt
    ? new Date(updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const externalSource = sourceName === EXTERNAL_SOURCE_NAME;

  return (
    <footer className="max-w-3xl mx-auto px-4 pb-12 space-y-3 text-xs text-[var(--text-muted)]">
      <div className="border-t border-[var(--border)] pt-4 space-y-2">
        {externalSource ? (
          <p>Источник: {EXTERNAL_SOURCE_NAME}</p>
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
