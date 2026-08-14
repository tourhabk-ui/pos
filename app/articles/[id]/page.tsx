import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Clock, CalendarDays, ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import {
  ARTICLES, ARTICLE_BY_ID, CATEGORY_LABEL, readingMinutes, detectArticles, articleFullText,
} from '@/lib/articles';

const SITE = 'https://vedarai.ru';

interface Props { params: Promise<{ id: string }> }

export function generateStaticParams() {
  return ARTICLES.map(a => ({ id: a.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const article = ARTICLE_BY_ID[id];
  if (!article) return { title: 'Статья не найдена' };

  return {
    title: `${article.title} — Ведар`,
    description: article.lead,
    keywords: article.keywords,
    alternates: { canonical: `${SITE}/articles/${id}` },
    openGraph: {
      title: article.title,
      description: article.lead,
      url: `${SITE}/articles/${id}`,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'article',
    },
  };
}

function formatUpdated(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

export default async function ArticlePage({ params }: Props) {
  const { id } = await params;
  const article = ARTICLE_BY_ID[id];
  if (!article) notFound();

  /**
   * Смежные статьи — те, что упомянуты в тексте этой. Связи не заводятся
   * руками: список «по теме», расходящийся с текстом, — это второй справочник
   * связей, который устареет при первой правке абзаца.
   */
  const related = detectArticles(articleFullText(article)).filter(a => a.id !== article.id);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.lead,
    dateModified: article.updated,
    inLanguage: 'ru-RU',
    author: { '@type': 'Organization', name: 'Ведар' },
    publisher: { '@type': 'Organization', name: 'Ведар' },
    mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE}/articles/${article.id}` },
  };

  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-16">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />

        <nav className="mb-6 text-sm">
          <Link
            href="/articles"
            className="inline-flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Все статьи
          </Link>
        </nav>

        <article>
          <header className="mb-8">
            <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
              {CATEGORY_LABEL[article.category]}
            </p>
            <h1 className="ds-h1 mb-4" style={{ fontFamily: 'var(--font-playfair)' }}>
              {article.title}
            </h1>

            {/* Цитируемый ответ в первом экране — см. комментарий к lead. */}
            <p
              className="text-[var(--text-primary)] font-medium"
              style={{ fontSize: '19px', lineHeight: '1.65', maxWidth: '62ch' }}
            >
              {article.lead}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                {readingMinutes(article)} мин
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5" aria-hidden="true" />
                Обновлено {formatUpdated(article.updated)}
              </span>
            </div>
          </header>

          <div className="space-y-8">
            {article.sections.map((s, i) => (
              <section key={i}>
                <h2 className="ds-h2 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
                  {s.heading}
                </h2>
                <div className="space-y-4">
                  {s.paragraphs.map((p, j) => (
                    <p
                      key={j}
                      className="text-[var(--text-secondary)]"
                      style={{ fontSize: '17px', lineHeight: '1.75', maxWidth: '68ch' }}
                    >
                      {p}
                    </p>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </article>

        {related.length > 0 && (
          <section className="ds-section mt-12 border-t border-[var(--border)] pt-8">
            <h2 className="ds-h2 mb-4" style={{ fontFamily: 'var(--font-playfair)' }}>
              По теме
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {related.map(a => (
                <Link
                  key={a.id}
                  href={`/articles/${a.id}`}
                  className="ds-card group flex items-start justify-between gap-3 p-4 transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <span className="font-semibold text-[var(--text-primary)] leading-snug">
                    {a.title}
                  </span>
                  <ChevronRight
                    className="w-4 h-4 shrink-0 mt-0.5 text-[var(--accent)] transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
