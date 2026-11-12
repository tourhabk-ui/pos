'use client';

/**
 * «Другое жильё на ваши даты» на странице заявки на жильё (план «после
 * отказа», этап 5).
 *
 * После ответа хозяина «Занято» гость читал на странице «другое жильё — на
 * странице жилья» и искал сам. Теперь под ответом стоит жильё той же зоны,
 * которое может принять на те же ночи, — теми же словами, что в сообщении
 * Ведара в чат (lib/stay/other-stays-words), и тем же порядком.
 *
 * Это не выбор Ведара и не обещание: «номера есть» — о календаре; заявку гость
 * оставляет сам на карточке объекта, и только тот хозяин получит его имя и
 * телефон.
 *
 * Три исхода (§4.0): названо — список; не нашлось — блока нет; не прочиталось
 * — строка об этом, а не пустота, которая читалась бы «другого нет».
 * Сторож — рендер: tests/unit/request-other-stays.test.tsx.
 */

import Link from 'next/link';
import { sitePath } from '@/components/requests/RequestOtherOffers';
import {
  OTHER_STAYS_LIMIT_NOTE_RU, OTHER_STAYS_NOT_ANSWER_RU, OTHER_STAYS_ORDER_NOTE_RU, otherStayDatesWords, type OtherStayDatesWord,
} from '@/lib/stay/other-stays-words';

export interface OtherStaysBlock {
  state: 'listed' | 'none' | 'failed';
  zone: string | null;
  check_in: string;
  check_out: string;
  guests: number | null;
  stays: Array<{
    name: string;
    accommodation_id: string;
    type: string | null;
    dates: OtherStayDatesWord;
    price_from: number | null;
    stay_total: number | null;
    url: string;
  }>;
}

export const OTHER_STAYS_FAILED_RU =
  'Другое жильё на ваши даты сейчас не прочиталось. Это не значит, что его нет: обновите страницу позже или посмотрите жильё в каталоге.';

function dayRu(value: string): string {
  const t = new Date(`${value}T00:00:00`);
  return Number.isNaN(t.getTime()) ? value : t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function capitalized(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

export function RequestOtherStays({ block }: { block: OtherStaysBlock | null | undefined }) {
  if (!block || block.state === 'none') return null;
  if (block.state === 'failed') {
    return (
      <p className="text-sm text-[var(--text-secondary)] pt-3 border-t border-[var(--border)]" role="status">
        {OTHER_STAYS_FAILED_RU}
      </p>
    );
  }
  if (block.stays.length === 0) return null;
  return (
    <section aria-labelledby="other-stays-title" className="space-y-3 pt-4 border-t border-[var(--border)]">
      <h2 id="other-stays-title" className="text-lg font-bold text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>
        Другое жильё с {dayRu(block.check_in)} по {dayRu(block.check_out)}{block.zone ? ` — ${block.zone}` : ''}
      </h2>
      <ol className="divide-y divide-[var(--border)]">
        {block.stays.map((s, i) => {
          const href = sitePath(s.url);
          return (
            <li key={s.accommodation_id} className="py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  {i + 1}. {s.name}{s.type ? <span className="font-normal text-[var(--text-secondary)]"> · {s.type}</span> : null}
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {capitalized(otherStayDatesWords({ dates: s.dates, priceFrom: s.price_from, stayTotal: s.stay_total }, block.guests))}.
                </p>
              </div>
              {href && (
                <a href={href} className="ds-btn ds-btn-secondary shrink-0" aria-label={`Оставить заявку: ${s.name}`}>
                  Оставить заявку
                </a>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-[var(--text-secondary)]">
        {OTHER_STAYS_LIMIT_NOTE_RU}{' '}
        <Link href="/accommodations" className="text-[var(--ocean)] hover:underline">Каталог жилья</Link>
      </p>
      <p className="text-xs text-[var(--text-muted)]">{OTHER_STAYS_NOT_ANSWER_RU}</p>
      <p className="text-xs text-[var(--text-muted)]">{OTHER_STAYS_ORDER_NOTE_RU}</p>
    </section>
  );
}
