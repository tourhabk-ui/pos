import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { authorFeedEnabled } from '@/lib/photos/author-credit';
import { loadAuthorFeed } from '@/lib/photos/author-feed';
import { AuthorPhotoGrid } from '@/components/media/AuthorPhotoGrid';

/**
 * Фотолента автора — «маленькая инста» (владелец 21.11). Что в неё попадает
 * и почему страница закрыта от индекса — lib/photos/author-feed.
 * Адрес — транслит имени из подписи; ни контактов, ни учётной записи.
 */
export const revalidate = 600;

type Props = { params: Promise<{ author: string }> };

const SLUG_RE = /^[a-z0-9-]{2,80}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { author } = await params;
  if (!authorFeedEnabled() || !SLUG_RE.test(author)) return { robots: { index: false, follow: false } };
  const res = await loadAuthorFeed(author);
  const name = res.state === 'ok' ? res.feed.name : 'Автор';
  return {
    title: `Фото: ${name} — снимки мест Камчатки`,
    description: `Снимки мест и маршрутов Камчатки на Ведаре, автор — ${name}.`,
    alternates: { canonical: `https://vedarai.ru/foto/${author}` },
    robots: { index: false, follow: true },
  };
}

export default async function AuthorFeedPage({ params }: Props) {
  const { author } = await params;
  if (!authorFeedEnabled() || !SLUG_RE.test(author)) notFound();
  const res = await loadAuthorFeed(author);
  if (res.state === 'none') notFound();
  return (
    <>
      <Header />
      <main className="ds-page px-4 pt-20 pb-16">
        {res.state === 'failed' ? (
          <p className="text-[var(--text-secondary)]">Снимки не загрузились. Обновите страницу чуть позже.</p>
        ) : (
          <>
            <div className="mb-6">
              <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">Фото</p>
              <h1 className="ds-h1 mb-2" style={{ fontFamily: 'var(--font-playfair)' }} data-testid="author-feed-name">
                {res.feed.name}
              </h1>
              <p className="text-sm text-[var(--text-secondary)] max-w-xl">
                Снимки автора на Ведаре: {res.feed.photos.length}. Нажмите на снимок — откроется место или маршрут, где он сделан.
              </p>
            </div>
            <AuthorPhotoGrid photos={res.feed.photos} />
            <p className="mt-8 text-xs text-[var(--text-muted)]">
              <Link href="/places" className="hover:text-[var(--accent)]">Все места Камчатки →</Link>
            </p>
          </>
        )}
      </main>
    </>
  );
}
