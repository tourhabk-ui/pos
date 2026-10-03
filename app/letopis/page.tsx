import type { Metadata } from 'next';
import Link from 'next/link';
import { ScrollText, ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { articlesByKind } from '@/lib/chronicle/articles';
import { kindLabel } from '@/lib/chronicle/kinds';
import { defaultOgImages } from '@/lib/seo/og-image';

export const metadata: Metadata = {
  title: 'Летопись Камчатки — история края',
  description:
    'Летопись Камчатки: статьи об истории края по источникам — Петропавловская оборона 1854 года и другие события.',
  alternates: { canonical: 'https://vedarai.ru/letopis' },
  openGraph: {
    images: defaultOgImages(),
    title: 'Летопись Камчатки',
    description: 'Статьи об истории Камчатки по источникам.',
    url: 'https://vedarai.ru/letopis',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

export default function ChronicleIndexPage() {
  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-16">
        <div className="mb-10">
          <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-widest mb-2">
            История края
          </p>
          <h1 className="ds-h1 mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            Летопись Камчатки
          </h1>
          <p className="text-[var(--text-secondary)] max-w-xl">
            Статьи об истории Камчатки — по источникам, которые названы в конце каждой. Летопись собирается постепенно.
          </p>
        </div>

        {articlesByKind().map((group) => (
          <section key={group.kind} className="max-w-3xl mb-10">
            <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-3">
              {kindLabel(group.kind)}
            </h2>
            <div className="grid grid-cols-1 gap-4">
              {group.articles.map((a) => (
                <Link
                  key={a.slug}
                  href={`/letopis/${a.slug}`}
                  className="ds-card group flex items-start gap-4 hover:shadow-md transition-all duration-200"
                >
                  <div className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 bg-[var(--bg-hover)]">
                    <ScrollText className="w-6 h-6 text-[var(--accent)]" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-[var(--text-muted)] mb-1">{a.period}</p>
                    <h3
                      className="text-lg font-bold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors"
                      style={{ fontFamily: 'var(--font-playfair)' }}
                    >
                      {a.title}
                    </h3>
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed mt-1">{a.lead}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0 mt-1" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
