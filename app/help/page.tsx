import type { Metadata } from 'next';
import Link from 'next/link';
import { Map, Package, Compass, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SupportCard } from '@/components/help/HelpArticleView';
import { HELP_ARTICLES, type HelpArticle } from '@/lib/help/content';

export const metadata: Metadata = {
  title: 'Центр помощи',
  description: 'Инструкции для туристов, операторов и гидов платформы Ведар',
};

const ICONS: Record<HelpArticle['slug'], LucideIcon> = {
  tourists: Map,
  operators: Package,
  guides: Compass,
};

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <div className="bg-[var(--bg-card)] border-b border-[var(--border)]">
        <div className="max-w-3xl mx-auto px-4 py-12 text-center">
          <h1 className="text-4xl font-bold text-[var(--text-primary)] mb-3" style={{ fontFamily: 'var(--font-playfair)' }}>
            Центр помощи
          </h1>
          <p className="text-[var(--text-secondary)] text-lg">Выберите раздел, который вам нужен</p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-12 space-y-8">
        <div className="grid md:grid-cols-3 gap-4">
          {HELP_ARTICLES.map((a) => {
            const Icon = ICONS[a.slug];
            return (
              <Link key={a.slug} href={`/help/${a.slug}`} className="ds-card p-6 hover:bg-[var(--bg-hover)] transition-colors group flex flex-col">
                <Icon size={24} className="text-[var(--accent)] mb-3" />
                <h2 className="text-lg font-bold text-[var(--text-primary)] mb-2 group-hover:text-[var(--accent)] transition-colors">
                  {a.audience}
                </h2>
                <p className="text-sm text-[var(--text-secondary)] mb-4 flex-1">{a.lead}</p>
                <span className="flex items-center gap-1 text-[var(--accent)] text-sm font-medium">
                  Открыть <ArrowRight size={16} />
                </span>
              </Link>
            );
          })}
        </div>
        <SupportCard />
      </div>
    </div>
  );
}
