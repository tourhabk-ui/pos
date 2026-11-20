import Link from 'next/link';
import type { PhotoCredit } from '@/lib/media/author-credit';

/**
 * Имя автора снимка — ссылкой, если ей есть куда вести (lib/media/
 * author-credit): страница партнёра или фотолента автора. Одинаково для всех
 * партнёров и авторов, без пометок и без порядка «лучших» (§0).
 */
export function PhotoCreditLink({ credit, className }: { credit: PhotoCredit; className?: string }) {
  if (!credit.href) return <span className={className}>{credit.name}</span>;
  return (
    <Link
      href={credit.href}
      className={className ?? 'underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]'}
      data-credit-kind={credit.kind}
    >
      {credit.name}
    </Link>
  );
}
