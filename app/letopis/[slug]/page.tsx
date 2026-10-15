import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, ArrowRight, BookOpen, MapPin, Route } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { CHRONICLE_ARTICLES, CHRONICLE_BY_SLUG } from '@/lib/chronicle/articles';
import { defaultOgImages } from '@/lib/seo/og-image';
import { metaDescription } from '@/lib/seo/meta-description';
import { photoPath } from '@/lib/images/photo-key';

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
  // Лид статьи длиннее сниппета (перепись 13.10: 177–205 знаков) — в выдачу
  // он идёт обрезанным по предложению или слову, на странице остаётся целым.
  const description = metaDescription(a.lead);
  return {
    title: `${a.title} — Летопись Камчатки`,
    description,
    alternates: { canonical: url },
    openGraph: {
      // Главный кадр статьи — и превью в мессенджерах; нет его — общий кадр.
      images: a.hero
        ? [{ url: `https://vedarai.ru${photoPath(a.hero.key)}`, width: a.hero.width, height: a.hero.height, alt: a.hero.alt }]
        : defaultOgImages(),
      title: a.title,
      description,
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
    ...(a.hero ? { image: `https://vedarai.ru${photoPath(a.hero.key)}` } : {}),
    publisher: { '@type': 'Organization', name: 'Ведар', url: 'https://vedarai.ru' },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Header />
      {/* px-4: ds-page даёт только отступ сверху, без полей текст на телефоне
          лежал вплотную к краю экрана (снимок 14.10, 390 px). */}
      <main className="ds-page px-4 pt-20 pb-16">
        <article className="max-w-2xl mx-auto">
          <Link
            href="/letopis"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] mb-6 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            Летопись Камчатки
          </Link>

          {/* Главный кадр, подпись целиком: название у автора, автор со
              ссылкой на файл, лицензия. Чего у снимка нет, того нет и в
              подписи: у снимка владельца (15.10) ни страницы-источника, ни
              лицензии — только имя, без ссылки и без « · ». */}
          {a.hero && (
            <figure className="mb-8">
              <Image
                src={photoPath(a.hero.key)}
                alt={a.hero.alt}
                width={a.hero.width}
                height={a.hero.height}
                // Без priority: предзагрузка по адресу-редиректу не совпадает
                // с загрузкой снимка и уходит вхолостую (замер 14.10 в браузере).
                loading="eager"
                fetchPriority="high"
                unoptimized
                sizes="(min-width: 672px) 672px, 100vw"
                className="w-full h-auto rounded-lg"
              />
              <figcaption className="mt-2 text-xs text-[var(--text-muted)]">
                {a.hero.caption}. Фото:{' '}
                {a.hero.sourceUrl ? (
                  <a href={a.hero.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
                    {a.hero.author}
                  </a>
                ) : (
                  a.hero.author
                )}
                {a.hero.license && (
                  <>
                    {' · '}
                    {a.hero.licenseUrl ? (
                      <a href={a.hero.licenseUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
                        {a.hero.license}
                      </a>
                    ) : (
                      a.hero.license
                    )}
                  </>
                )}
              </figcaption>
            </figure>
          )}

          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">{a.period}</p>
          <h1
            className="text-4xl md:text-5xl font-bold text-[var(--text-primary)] leading-tight mb-4"
            style={{ fontFamily: 'var(--font-playfair)' }}
          >
            {a.title}
          </h1>
          <p className="text-lg text-[var(--text-secondary)] leading-relaxed mb-10">{a.lead}</p>

          {/* Главные даты — оглавление по годам (14.10). Каждая веха
              пересказывает раздел ниже, год стоит в тексте статьи. */}
          {a.timeline && a.timeline.length > 0 && (
            <section aria-labelledby="chronicle-dates" className="mb-12">
              <h2 id="chronicle-dates" className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-4">
                Главные даты
              </h2>
              <ol className="ml-1.5 border-l border-[var(--border)]">
                {a.timeline.map((d, i) => (
                  <li key={`${d.year}-${i}`} className="relative pl-6 pb-5 last:pb-0">
                    <span aria-hidden="true" className="absolute -left-[5px] top-2 h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
                    <p
                      className="text-2xl font-bold text-[var(--accent)] leading-none"
                      style={{ fontFamily: 'var(--font-playfair)' }}
                    >
                      {d.year}
                    </p>
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed mt-1.5">{d.event}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

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

          {/* Куда дальше на платформе: карточка места, маршруты. */}
          {a.links && a.links.length > 0 && (
            <nav aria-label="На карте и в маршрутах" className="mt-12 grid gap-3 sm:grid-cols-2">
              {a.links.map((l) => {
                const Icon = l.href.startsWith('/places/') ? MapPin : Route;
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="ds-card block transition-all duration-200 hover:bg-[var(--bg-hover)]"
                  >
                    <span className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                      <Icon className="w-4 h-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
                      {l.label}
                      <ArrowRight className="w-4 h-4 ml-auto shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                    </span>
                    <span className="block text-sm text-[var(--text-secondary)] mt-1">{l.hint}</span>
                  </Link>
                );
              })}
            </nav>
          )}

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
