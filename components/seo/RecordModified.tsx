import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';

/**
 * Видимая дата последней правки записи (lib/seo/record-modified). Без
 * 'use client' и без хуков — рисуется и в серверном, и в клиентском дереве
 * одной и той же строкой. Даты нет — нет и строки.
 */
export function RecordModified({ value, className }: { value: string | Date | null | undefined; className?: string }) {
  const text = formatRecordDate(value);
  const iso = recordDateIso(value);
  if (!text || !iso) return null;
  return (
    <p className={className ?? 'text-xs text-[var(--text-muted)]'} data-record-modified="">
      Последняя правка записи: <time dateTime={iso}>{text}</time>
    </p>
  );
}
