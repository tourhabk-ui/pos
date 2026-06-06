import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, Rss } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Блог TourHab — Камчатка: маршруты, безопасность, операторы',
  description:
    'Актуальные материалы о путешествиях по Камчатке: обновления маршрутов, разведданные о сезоне, новости платформы и советы по безопасности.',
  keywords: [
    'блог камчатка',
    'путешествия камчатка',
    'маршруты камчатка новости',
    'туризм камчатка 2026',
  ],
  alternates: { canonical: `${SITE}/blog` },
  openGraph: {
    title: 'Блог TourHab — Камчатка',
    description: 'Актуальные материалы о путешествиях и безопасности на Камчатке.',
    url: `${SITE}/blog`,
    siteName: 'TourHab',
    locale: 'ru_RU',
    type: 'website',
  },
};

interface DigestEntry {
  slug: string;
  title: string;
  compiled_truth: string;
  created_at: string;
}

async function getLatestDigests(): Promise<DigestEntry[]> {
  try {
    const { rows } = await pool.query<DigestEntry>(`
      SELECT slug, title, compiled_truth, created_at::text
      FROM agent_knowledge
      WHERE type IN ('digest', 'decision')
        AND (slug LIKE 'digest/%' OR slug LIKE 'proposals/%')
      ORDER BY created_at DESC
      LIMIT 9
    `);
    return rows;
  } catch {
    return [];
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

const STATIC_ARTICLES = [
  {
    slug: 'kamchatka-season-2026',
    title: 'Сезон 2026 на Камчатке: что изменилось',
    excerpt:
      'Открытие маршрутов, новые ограничения Кроноцкого заповедника, погодные аномалии июня и рекомендации по подготовке к летнему сезону.',
    tag: 'Сезон',
    date: '2026-06-01',
  },
  {
    slug: 'sos-offline-guide',
    title: 'Как работает SOS-кнопка без интернета',
    excerpt:
      'Подробный разбор: как TourHab сохраняет координаты GPS, отправляет сигнал тревоги и передаёт маршрут экстренным службам даже без сети.',
    tag: 'Безопасность',
    date: '2026-05-20',
  },
  {
    slug: 'operators-2026',
    title: 'Верифицированные операторы Камчатки 2026',
    excerpt:
      'Критерии проверки, как отличить надёжного оператора от однодневки и почему TourHab не добавляет анонимные предложения в каталог.',
    tag: 'Операторы',
    date: '2026-05-10',
  },
];

export default async function BlogPage() {
  const digests = await getLatestDigests();

  return (
    <>
      <Header />
      <main className="bg-[var(--bg-primary)] min-h-screen">

        {/* Hero */}
        <section className="pt-24 pb-12 px-6">
          <div className="max-w-4xl mx-auto">
            <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-6 inline-block">
              Блог
            </span>
            <h1 className="font-playfair text-4xl md:text-5xl font-bold leading-tight text-[var(--text-primary)] mb-4">
              Камчатка: маршруты,<br />
              <span className="text-[var(--accent)] italic">безопасность, сезон</span>
            </h1>
            <p className="text-[var(--text-secondary)] text-lg font-light max-w-2xl">
              Разборы маршрутов, обновления сезона, новости платформы и сигналы от агентов разведки.
            </p>
          </div>
        </section>

        {/* Static articles */}
        <section className="px-6 pb-12">
          <div className="max-w-4xl mx-auto">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-6">
              Материалы редакции
            </p>
            <div className="grid md:grid-cols-3 gap-6">
              {STATIC_ARTICLES.map((a) => (
                <article
                  key={a.slug}
                  className="ds-card flex flex-col gap-3 p-5 hover:border-[var(--accent)] transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent)] bg-[var(--bg-hover)] px-2 py-0.5 rounded">
                      {a.tag}
                    </span>
                    <time className="text-xs text-[var(--text-muted)]">
                      {formatDate(a.date)}
                    </time>
                  </div>
                  <h2 className="font-semibold text-[var(--text-primary)] leading-snug">
                    {a.title}
                  </h2>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed flex-1">
                    {a.excerpt}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Scout digests */}
        {digests.length > 0 && (
          <section className="px-6 pb-16 border-t border-[var(--border)] pt-12">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center gap-2 mb-6">
                <Rss className="w-4 h-4 text-[var(--accent)]" />
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                  Разведдайджест — автоматический синтез
                </p>
              </div>
              <div className="space-y-4">
                {digests.map((d) => (
                  <div
                    key={d.slug}
                    className="ds-card p-5 flex flex-col gap-2"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-semibold text-[var(--text-primary)] text-sm leading-snug">
                        {d.title}
                      </h3>
                      <time className="text-xs text-[var(--text-muted)] shrink-0">
                        {formatDate(d.created_at)}
                      </time>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3">
                      {stripHtml(d.compiled_truth).slice(0, 280)}
                      {d.compiled_truth.length > 280 ? '…' : ''}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* CTA */}
        <section className="py-12 px-6 border-t border-[var(--border)]">
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row gap-4">
            <Link
              href="/routes"
              className="ds-btn ds-btn-primary inline-flex items-center gap-2"
            >
              Смотреть маршруты
              <ChevronRight className="w-4 h-4" />
            </Link>
            <Link
              href="/hub/safety"
              className="ds-btn ds-btn-secondary inline-flex items-center gap-2"
            >
              Безопасность
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

      </main>
      <Footer />
    </>
  );
}
