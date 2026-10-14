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
import { getArticle, listArticleLinks, type ArticleLink } from '@/lib/articles/queries';
import { circularNext } from '@/lib/seo/circular-links';
import { defaultOgImages } from '@/lib/seo/og-image';
import { metaDescription } from '@/lib/seo/meta-description';

export const dynamic = 'force-dynamic';

/**
 * Сколько статей предлагать дальше. Перепись 14.10 (прогон 10): на каждую из
 * 27 статей вела одна ссылка — с оглавления. Следующие по кругу дают каждой
 * ровно READ_NEXT входящих (lib/seo/circular-links).
 */
const READ_NEXT = 4;

/** Соседи по оглавлению. Не прочитались — блока нет, причина в логе (§4.0). */
async function readNext(slug: string): Promise<ArticleLink[]> {
  try {
    return circularNext(await listArticleLinks(), (a) => a.slug === slug, READ_NEXT);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[articles/page] соседние статьи не прочитаны:', slug, `sqlstate=${err?.code ?? 'нет'}`, err?.message ?? String(e));
    return [];
  }
}

interface Props { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) return { title: 'Статья не найдена' };

  // По предложению или слову, а не slice(0, 160) посреди слова (lib/seo/meta-description).
  const description = metaDescription(article.body);
  return {
    title: article.title,
    description: description || `${article.title}: материал о Камчатке.`,
    alternates: { canonical: `https://vedarai.ru/articles/${article.slug}` },
    openGraph: {
      images: defaultOgImages(),
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
  const next = await readNext(article.slug);

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

        {next.length > 0 && (
          <nav aria-labelledby="read-next" className="max-w-2xl mt-12">
            <h2 id="read-next" className="ds-h2 mb-4">Читайте дальше</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {next.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/articles/${a.slug}`}
                    className="ds-card block h-full p-4 transition-all duration-200 hover:bg-[var(--bg-hover)]"
                  >
                    {a.topic && (
                      <span className="block text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-1">
                        {a.topic}
                      </span>
                    )}
                    <span className="font-medium text-[var(--text-primary)]">{a.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </main>
    </>
  );
}
