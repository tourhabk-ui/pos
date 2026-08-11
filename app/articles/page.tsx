/**
 * Раздел статей — оглавление.
 *
 * Построен как справочник рыб (`/fish`) по решению владельца 11.08: «нужно
 * сделать раздел статьи так же как с видами рыб, это было бы логичней».
 *
 * Содержимое пришло из справочника МАРШРУТОВ, где двадцать шесть заметок
 * («Флора Камчатки», «Растения Камчатки», «Экологические проблемы Камчатки»)
 * лежали видимыми — то есть предлагались туристу как то, по чему можно пойти.
 * Текст не мусор; мусором его делала неправильная полка.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen, ArrowRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { listArticles, groupByTopic } from '@/lib/articles/queries';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Статьи о Камчатке — природа, край, сезоны',
  description:
    'Статьи о Камчатке: флора и фауна, рельеф, реки и водопады, посёлки, сезоны, экология. Справочные материалы для тех, кто собирается на полуостров.',
  keywords: [
    'статьи о Камчатке', 'природа Камчатки', 'флора Камчатки', 'растения Камчатки',
    'рельеф Камчатки', 'водопады Камчатки', 'зима на Камчатке', 'экология Камчатки',
  ],
  alternates: { canonical: 'https://vedarai.ru/articles' },
  openGraph: {
    title: 'Статьи о Камчатке',
    description: 'Природа, край, сезоны — справочные материалы о полуострове.',
    url: 'https://vedarai.ru/articles',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

/** Первые предложения текста — чтобы по карточке было понятно, о чём статья. */
function excerpt(body: string | null, limit = 160): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export default async function ArticlesIndexPage() {
  const articles = await listArticles();
  const groups = groupByTopic(articles);

  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-16">
        <div className="mb-10">
          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
            Справочник
          </p>
          <h1 className="ds-h1 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            Статьи о Камчатке
          </h1>
          <p className="text-[var(--text-secondary)] max-w-xl">
            Природа, край и сезоны полуострова — то, что стоит прочитать до выхода на маршрут.
          </p>
        </div>

        {/* Пусто — так и сказано. Молчаливая страница читалась бы как поломка. */}
        {articles.length === 0 ? (
          <div className="ds-card p-8 text-center">
            <BookOpen className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)]" />
            <p className="text-[var(--text-secondary)]">Статей пока нет.</p>
          </div>
        ) : (
          <div className="space-y-10">
            {groups.map((group) => (
              <section key={group.topic}>
                <h2 className="ds-h2 mb-4" style={{ fontFamily: 'var(--font-playfair)' }}>
                  {group.topic}
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map((a) => (
                    <Link
                      key={a.slug}
                      href={`/articles/${a.slug}`}
                      className="ds-card p-5 block transition-all duration-200 hover:bg-[var(--bg-hover)]"
                    >
                      <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">
                        {a.title}
                      </h3>
                      {excerpt(a.body) && (
                        <p className="text-sm text-[var(--text-secondary)] mb-3">{excerpt(a.body)}</p>
                      )}
                      <span className="inline-flex items-center gap-1 text-sm text-[var(--ocean)]">
                        Читать <ArrowRight className="w-4 h-4" />
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
