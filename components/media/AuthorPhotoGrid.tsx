import Link from 'next/link';
import type { FeedPhoto } from '@/lib/media/author-feed';

/**
 * Сетка ленты автора: квадраты, с каждого — переход на место или маршрут.
 * Первые снимки — в первом экране (LCP): без ленивой загрузки.
 * alt — название места; лицензия — под снимком, если записана.
 */
export function AuthorPhotoGrid({ photos }: { photos: readonly FeedPhoto[] }) {
  return (
    <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2" data-testid="author-feed-grid">
      {photos.map((p, i) => (
        <li key={p.url} className="rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-card)]">
          <Link href={p.href} className="block group" data-testid="author-feed-item">
            <div className="relative aspect-square bg-[var(--bg-hover)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.url}
                alt={p.alt}
                loading={i < 4 ? 'eager' : 'lazy'}
                {...(i < 2 ? { fetchPriority: 'high' as const } : {})}
                decoding="async"
                className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
            </div>
            <p className="px-2 pt-1.5 text-xs font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)]">{p.alt}</p>
          </Link>
          {p.license && <p className="px-2 pb-1.5 text-[11px] text-[var(--text-muted)] truncate">{p.license}</p>}
        </li>
      ))}
    </ul>
  );
}
