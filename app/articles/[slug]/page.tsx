/**
 * Страница статьи.
 *
 * Текст пришёл из справочника маршрутов, где лежал заметкой источника. Здесь
 * он показывается тем, что он есть: статьёй. Ни карты, ни кнопки «в путь» —
 * идти тут некуда, и предлагать это было бы обманом.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { getArticle } from '@/lib/articles/queries';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) return { title: 'Статья не найдена' };

  const description = (article.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    title: `${article.title} — Ведар`,
    description: description || `${article.title}: материал о Камчатке.`,
    alternates: { canonical: `https://vedarai.ru/articles/${article.slug}` },
    openGraph: {
      title: article.title,
      description: description || undefined,
      url: `https://vedarai.ru/articles/${article.slug}`,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'article',
    },
  };
}

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) notFound();

  // Абзацы — по пустым строкам. Текст пришёл из скрейпа, разметки в нём нет.
  const paragraphs = (article.body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-16">
        <Link
          href="/articles"
          className="inline-flex items-center gap-1 text-sm text-[var(--ocean)] mb-6 transition-all duration-200 hover:opacity-80"
        >
          <ArrowLeft className="w-4 h-4" /> Все статьи
        </Link>

        <article className="max-w-2xl">
          {article.topic && (
            <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
              {article.topic}
            </p>
          )}
          <h1 className="ds-h1 mb-6" style={{ fontFamily: 'var(--font-playfair)' }}>
            {article.title}
          </h1>

          {paragraphs.length === 0 ? (
            // Текста нет — так и сказано. Пустая страница читалась бы как сбой.
            <p className="text-[var(--text-secondary)]">
              Текст статьи не сохранился при переносе.
            </p>
          ) : (
            <div className="space-y-4">
              {paragraphs.map((p, i) => (
                <p key={i} className="text-[var(--text-primary)] leading-relaxed">{p}</p>
              ))}
            </div>
          )}

          {/* Первоисточник называется: текст не наш, и приписывать его себе нельзя. */}
          {article.sourceUrl && (
            <p className="mt-8 pt-4 border-t border-[var(--border)] text-sm text-[var(--text-muted)]">
              Источник:{' '}
              <a
                href={article.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 text-[var(--ocean)]"
              >
                {article.sourceName || new URL(article.sourceUrl).hostname}
                <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          )}
        </article>
      </main>
    </>
  );
}
