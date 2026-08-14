import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen, Clock, ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { ARTICLES, CATEGORY_LABEL, readingMinutes, type ArticleCategory } from '@/lib/articles';

const SITE = 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Статьи — справочник Ведара по Камчатке',
  description:
    'Справочные материалы для самостоятельной поездки на Камчатку: регистрация группы в МЧС, офлайн-карта до выхода, достоверность треков, сезон лосося, аттестация инструкторов-проводников.',
  keywords: [
    'Камчатка статьи', 'подготовка к походу Камчатка', 'регистрация в МЧС',
    'офлайн карта Камчатка', 'безопасность на маршруте', 'справочник туриста',
  ],
  alternates: { canonical: `${SITE}/articles` },
  openGraph: {
    title: 'Статьи — справочник Ведара по Камчатке',
    description: 'Что нужно знать до выхода: регистрация, карта, треки, сезоны, гиды.',
    url: `${SITE}/articles`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

/** Порядок разделов на витрине: сначала то, что читают перед выходом. */
const CATEGORY_ORDER: ArticleCategory[] = ['safety', 'preparation', 'rules', 'nature'];

export default function ArticlesIndexPage() {
  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-16">

        <div className="mb-10">
          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
            Справочник
          </p>
          <h1 className="ds-h1 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            Статьи
          </h1>
          <p
            className="text-[var(--text-secondary)]"
            style={{ fontSize: '17px', lineHeight: '1.7', maxWidth: '62ch' }}
          >
            То, что стоит прочитать до выхода, а не на маршруте. Каждая статья отвечает
            на один вопрос и говорит, откуда мы знаем ответ.
          </p>
        </div>

        {CATEGORY_ORDER.map(cat => {
          const items = ARTICLES.filter(a => a.category === cat);
          if (items.length === 0) return null;

          return (
            <section key={cat} className="ds-section">
              <h2
                className="ds-h2 mb-4 flex items-center gap-2"
                style={{ fontFamily: 'var(--font-playfair)' }}
              >
                <BookOpen className="w-5 h-5 text-[var(--ocean)]" aria-hidden="true" />
                {CATEGORY_LABEL[cat]}
              </h2>

              <div className="grid gap-3 sm:grid-cols-2">
                {items.map(a => (
                  <Link
                    key={a.id}
                    href={`/articles/${a.id}`}
                    className="ds-card group flex flex-col gap-2 p-5 transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <h3 className="font-bold text-[var(--text-primary)] leading-snug">
                      {a.title}
                    </h3>
                    <p
                      className="text-[var(--text-secondary)] flex-1"
                      style={{ fontSize: '15px', lineHeight: '1.6' }}
                    >
                      {a.lead}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                        {readingMinutes(a)} мин
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1 text-[var(--accent)] font-semibold">
                        Читать
                        <ChevronRight
                          className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </main>
    </>
  );
}
