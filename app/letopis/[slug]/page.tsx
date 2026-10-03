import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { CHRONICLE_ARTICLES, CHRONICLE_BY_SLUG } from '@/lib/chronicle/articles';
import { defaultOgImages } from '@/lib/seo/og-image';

// Статьи — константа в коде, базы страница не трогает: собрать их на сборке
// безопасно (ср. tests/unit/no-build-time-db.test.ts).
export function generateStaticParams() {
  return CHRONICLE_ARTICLES.map((a) => ({ slug: a.slug }));
}

interface Props { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const a = CHRONICLE_BY_SLUG[slug];
  if (!a) return { title: 'Статья не найдена' };
  const url = `https://vedarai.ru/letopis/${a.slug}`;
  return {
    title: `${a.title} — Летопись Камчатки`,
    description: a.lead,
    alternates: { canonical: url },
    openGraph: {
      images: defaultOgImages(),
      title: a.title,
      description: a.lead,
      url,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'article',
    },
  };
}

export default async function ChronicleArticlePage({ params }: Props) {
  const { slug } = await params;
  const a = CHRONICLE_BY_SLUG[slug];
  if (!a) notFound();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.lead,
    url: `https://vedarai.ru/letopis/${a.slug}`,
    inLanguage: 'ru',
    dateModified: a.checkedAt,
    citation: a.sources.map((s) => s.url),
    publisher: { '@type': 'Organization', name: 'Ведар', url: 'https://vedarai.ru' },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Header />
      <main className="ds-page pt-20 pb-16">
        <article className="max-w-2xl mx-auto">
          <Link
            href="/letopis"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] mb-6 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            Летопись Камчатки
          </Link>

          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">{a.period}</p>
          <h1
            className="text-4xl md:text-5xl font-bold text-[var(--text-primary)] leading-tight mb-4"
            style={{ fontFamily: 'var(--font-playfair)' }}
          >
            {a.title}
          </h1>
          <p className="text-lg text-[var(--text-secondary)] leading-relaxed mb-10">{a.lead}</p>

          {a.sections.map((section) => (
            <section key={section.heading} className="mb-10">
              <h2
                className="text-2xl font-bold text-[var(--text-primary)] mb-4"
                style={{ fontFamily: 'var(--font-playfair)' }}
              >
                {section.heading}
              </h2>
              {section.paragraphs.map((p, i) =>
                typeof p === 'string' ? (
                  <p key={i} className="text-[var(--text-primary)] leading-relaxed mb-4">{p}</p>
                ) : (
                  <figure key={i} className="my-6 border-l-2 border-[var(--accent)] pl-4">
                    <blockquote className="italic text-[var(--text-secondary)] leading-relaxed">«{p.quote}»</blockquote>
                    <figcaption className="text-sm text-[var(--text-muted)] mt-2">— {p.by}</figcaption>
                  </figure>
                ),
              )}
            </section>
          ))}

          <section className="ds-card mt-12">
            <h2 className="flex items-center gap-2 font-semibold text-[var(--text-primary)] mb-3">
              <BookOpen className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
              Источники
            </h2>
            <ul className="space-y-2">
              {a.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--ocean)] hover:underline">
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-xs text-[var(--text-muted)] mt-3">
              Где источники расходятся, в тексте приведены оба числа. Сверено с источниками {a.checkedAt.split('-').reverse().join('.')}.
            </p>
          </section>
        </article>
      </main>
    </>
  );
}
