import type { Metadata } from 'next';
import { pool } from '@/lib/db-pool';
import { Shield, Award, Star, Phone } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Сертифицированные гиды Камчатки',
  description: '112 аттестованных гидов. Лицензии, специализации, отзывы туристов. Выбирайте проверенного гида для безопасного путешествия по Камчатке.',
  openGraph: {
    title: 'Сертифицированные гиды Камчатки',
    description: '112 аттестованных гидов с лицензиями и отзывами туристов.',
    url: 'https://vedarai.ru/guides',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

interface Guide {
  id: string;
  name: string;
  company_name: string | null;
  description: string | null;
  rating: number;
  review_count: number;
  is_verified: boolean;
  certifications: string[];
}

async function getGuides(): Promise<Guide[]> {
  try {
    const { rows } = await pool.query<{
      id: string; name: string; company_name: string | null;
      description: string | null; rating: number; review_count: number;
      is_verified: boolean; certs: string | null;
    }>(
      `SELECT p.id, p.name, p.company_name, p.description,
              COALESCE(p.rating, 0) AS rating,
              COALESCE(p.review_count, 0) AS review_count,
              COALESCE(p.is_verified, false) AS is_verified,
              STRING_AGG(gc.name, '||') AS certs
       FROM partners p
       LEFT JOIN guide_certifications gc ON gc.guide_id = p.id AND gc.is_verified = true
       WHERE p.category = 'guide' AND p.profile_status = 'active'
       GROUP BY p.id, p.name, p.company_name, p.description, p.rating, p.review_count, p.is_verified
       ORDER BY p.is_verified DESC, p.rating DESC, p.review_count DESC
       LIMIT 100`
    );
    return rows.map(r => ({
      ...r,
      certifications: r.certs ? r.certs.split('||').filter(Boolean) : [],
    }));
  } catch {
    return [];
  }
}

export default async function GuidesPage() {
  const guides = await getGuides();
  const verifiedCount = guides.filter(g => g.is_verified).length;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Сертифицированные гиды Камчатки',
    description: 'Реестр аттестованных туристических гидов Камчатского края',
    numberOfItems: guides.length,
    itemListElement: guides.slice(0, 10).map((g, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Person',
        name: g.name,
        jobTitle: 'Туристический гид',
        worksFor: g.company_name ? { '@type': 'Organization', name: g.company_name } : undefined,
        description: g.description?.slice(0, 200),
        address: { '@type': 'PostalAddress', addressRegion: 'Камчатский край', addressCountry: 'RU' },
      },
    })),
    provider: { '@type': 'TravelAgency', name: 'Ведар', url: 'https://vedarai.ru' },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="ds-page py-10">
        {/* Hero */}
        <div className="mb-10">
          <p className="text-xs font-semibold tracking-widest text-[var(--accent)] uppercase mb-3">
            Реестр гидов
          </p>
          <h1 className="ds-h1 mb-4">Сертифицированные гиды Камчатки</h1>
          <p className="text-[var(--text-secondary)] text-lg max-w-2xl">
            Только гиды с подтверждёнными лицензиями и аттестатами. Каждый проверен командой Ведара.
          </p>

          {/* Trust stats */}
          <div className="flex flex-wrap gap-6 mt-8">
            {[
              { icon: Shield, label: 'Верифицировано', value: `${verifiedCount} гидов` },
              { icon: Award, label: 'С аттестатами', value: `${guides.filter(g => g.certifications.length > 0).length} гидов` },
              { icon: Star, label: 'Средний рейтинг', value: guides.length > 0 ? (guides.reduce((s, g) => s + g.rating, 0) / guides.length).toFixed(1) : '—' },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-center gap-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-5 py-3">
                <Icon size={18} className="text-[var(--accent)]" />
                <div>
                  <div className="text-xs text-[var(--text-muted)]">{label}</div>
                  <div className="text-base font-bold text-[var(--text-primary)]">{value}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Guides grid */}
        {guides.length === 0 ? (
          <div className="ds-card text-center py-16">
            <p className="text-[var(--text-muted)]">Реестр гидов скоро будет опубликован</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {guides.map(guide => (
              <div key={guide.id} className="ds-card flex flex-col gap-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="font-semibold text-[var(--text-primary)] truncate">{guide.name}</h2>
                      {guide.is_verified && (
                        <Shield size={14} className="text-[var(--success)] flex-shrink-0" />
                      )}
                    </div>
                    {guide.company_name && (
                      <p className="text-xs text-[var(--text-muted)] truncate">{guide.company_name}</p>
                    )}
                  </div>
                  {guide.rating > 0 && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Star size={13} className="text-[var(--warning)] fill-[var(--warning)]" />
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {guide.rating.toFixed(1)}
                      </span>
                      {guide.review_count > 0 && (
                        <span className="text-xs text-[var(--text-muted)]">({guide.review_count})</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Description */}
                {guide.description && (
                  <p className="text-sm text-[var(--text-secondary)] line-clamp-3">
                    {guide.description}
                  </p>
                )}

                {/* Certifications */}
                {guide.certifications.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {guide.certifications.slice(0, 3).map(cert => (
                      <span
                        key={cert}
                        className="inline-flex items-center gap-1 text-xs bg-[var(--bg-hover)] text-[var(--text-secondary)] px-2 py-0.5 rounded"
                      >
                        <Award size={10} className="text-[var(--accent)]" />
                        {cert.length > 30 ? cert.slice(0, 30) + '…' : cert}
                      </span>
                    ))}
                  </div>
                )}

                {/* Contact CTA */}
                <a
                  href={`/operators?guide=${guide.id}`}
                  className="mt-auto flex items-center justify-center gap-2 text-sm font-medium text-[var(--accent)] border border-[var(--accent)]/30 rounded-lg py-2 hover:bg-[var(--accent)]/5 transition-colors"
                >
                  <Phone size={13} />
                  Связаться
                </a>
              </div>
            ))}
          </div>
        )}

        {/* CTA for guides */}
        <div className="mt-12 ds-card text-center py-10">
          <h2 className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-3">
            Вы гид на Камчатке?
          </h2>
          <p className="text-[var(--text-secondary)] mb-6 max-w-md mx-auto">
            Присоединяйтесь к реестру Ведара. Верификация лицензий, выход к туристам, управление бронированиями.
          </p>
          <a href="/for-operators" className="ds-btn ds-btn-primary inline-flex">
            Стать гидом на платформе
          </a>
        </div>
      </div>
    </>
  );
}
