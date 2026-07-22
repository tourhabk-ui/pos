import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { pool } from '@/lib/db-pool';
import { Shield, Award, Star, ArrowLeft, Languages, Mountain, BadgeCheck, Phone, Clock } from 'lucide-react';

// Публичный профиль гида — витрина доверия (паттерн 57hours): турист видит
// ПОДТВЕРЖДЁННЫЕ аттестаты до брони, а не просто «112 аттестованных» цифрой.
// Всё из данных, что реально есть (guide_certifications.is_verified, partners).
// Ничего не выдумываем: нет аттестатов — честно «на модерации».

interface GuideProfile {
  id: string;
  name: string;
  company_name: string | null;
  description: string | null;
  rating: number;
  review_count: number;
  is_verified: boolean;
  languages: string[] | null;
  specializations: string[] | null;
  experience_years: number | null;
  photo_url: string | null;
  phone: string | null;
}

interface Cert {
  name: string;
  is_verified: boolean;
  expiry_date: string | null;
}

const SPEC_LABELS: Record<string, string> = {
  volcanoes: 'Вулканы', wildlife: 'Дикая природа', fishing: 'Рыбалка',
  history: 'История', photography: 'Фотоохота', extreme: 'Экстрим',
  hiking: 'Треккинг', cultural: 'Культура', rafting: 'Рафтинг', skiing: 'Лыжи',
};

async function getGuide(id: string): Promise<{ guide: GuideProfile; certs: Cert[] } | null> {
  try {
    const { rows } = await pool.query<GuideProfile>(
      `SELECT p.id, p.name, p.company_name, p.description,
              COALESCE(p.rating, 0) AS rating,
              COALESCE(p.review_count, 0) AS review_count,
              COALESCE(p.is_verified, false) AS is_verified,
              p.languages, p.specializations, p.experience_years, p.photo_url, p.phone
       FROM partners p
       WHERE p.id = $1 AND p.category = 'guide' AND p.profile_status = 'active'
       LIMIT 1`,
      [id],
    );
    if (rows.length === 0) return null;

    // Аттестаты — в отдельном try: схемная неожиданность не должна валить профиль.
    let certs: Cert[] = [];
    try {
      const c = await pool.query<Cert>(
        `SELECT name, is_verified, expiry_date
         FROM guide_certifications
         WHERE guide_id = $1 AND is_verified = true
         ORDER BY created_at DESC`,
        [id],
      );
      certs = c.rows;
    } catch { /* нет аттестатов / другая схема — покажем честную пустоту */ }

    return { guide: rows[0], certs };
  } catch {
    return null;
  }
}

function fmtDate(d: string | null): string | null {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const data = await getGuide(id);
  if (!data) return { title: 'Гид не найден' };
  const { guide } = data;
  const title = `${guide.name} — сертифицированный гид Камчатки`;
  const description = guide.description?.slice(0, 160)
    ?? `${guide.name}: подтверждённые аттестаты, специализации, рейтинг. Проверенный гид для безопасного путешествия по Камчатке.`;
  return {
    title,
    description,
    openGraph: { title, description, url: `https://vedarai.ru/guides/${id}`, siteName: 'Ведар', locale: 'ru_RU', type: 'profile' },
  };
}

export default async function GuideProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getGuide(id);
  if (!data) notFound();
  const { guide, certs } = data;

  const initials = guide.name.split(' ').slice(0, 2).map((s) => s[0]).join('').toUpperCase();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: guide.name,
    jobTitle: 'Сертифицированный туристический гид',
    worksFor: guide.company_name ? { '@type': 'Organization', name: guide.company_name } : undefined,
    description: guide.description?.slice(0, 300),
    knowsLanguage: guide.languages ?? undefined,
    address: { '@type': 'PostalAddress', addressRegion: 'Камчатский край', addressCountry: 'RU' },
    aggregateRating: guide.review_count > 0
      ? { '@type': 'AggregateRating', ratingValue: guide.rating, reviewCount: guide.review_count }
      : undefined,
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="ds-page py-8">
        <Link href="/guides" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors mb-6">
          <ArrowLeft size={15} /> Все гиды
        </Link>

        {/* Hero */}
        <div className="flex items-start gap-5 mb-8">
          {guide.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={guide.photo_url} alt={guide.name} className="w-20 h-20 rounded-2xl object-cover flex-shrink-0" />
          ) : (
            <div className="w-20 h-20 rounded-2xl bg-[var(--ocean)]/10 flex items-center justify-center flex-shrink-0">
              <span className="font-playfair text-2xl font-bold text-[var(--ocean)]">{initials}</span>
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-playfair text-2xl sm:text-3xl font-bold text-[var(--text-primary)]">{guide.name}</h1>
              {guide.is_verified && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--success)] bg-[var(--success)]/10 px-2 py-0.5 rounded-full">
                  <Shield size={12} /> Проверен Ведаром
                </span>
              )}
            </div>
            {guide.company_name && <p className="text-sm text-[var(--text-muted)] mt-1">{guide.company_name}</p>}
            <div className="flex items-center gap-4 mt-2 text-sm">
              {guide.rating > 0 && (
                <span className="inline-flex items-center gap-1 text-[var(--text-primary)] font-medium">
                  <Star size={14} className="text-[var(--warning)] fill-[var(--warning)]" />
                  {guide.rating.toFixed(1)}
                  {guide.review_count > 0 && <span className="text-[var(--text-muted)] font-normal">({guide.review_count})</span>}
                </span>
              )}
              {guide.experience_years ? (
                <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
                  <Clock size={14} /> {guide.experience_years} {guide.experience_years === 1 ? 'год' : 'лет'} опыта
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Аттестаты — ядро доверия */}
        <section className="ds-card mb-5">
          <h2 className="ds-label flex items-center gap-2 mb-4">
            <span className="w-4 h-px bg-[var(--accent)]/70" aria-hidden /> Аттестаты и лицензии
          </h2>
          {certs.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Аттестаты на модерации — появятся после проверки командой Ведара.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {certs.map((c, i) => {
                const until = fmtDate(c.expiry_date);
                return (
                  <li key={`${c.name}-${i}`} className="flex items-start gap-3">
                    <span className="flex items-center justify-center w-9 h-9 rounded-full bg-[var(--success)]/10 flex-shrink-0">
                      <BadgeCheck size={18} className="text-[var(--success)]" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{c.name}</p>
                      <p className="text-xs text-[var(--text-muted)]">
                        Подтверждён Ведаром{until ? ` · действует до ${until}` : ''}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* О гиде */}
        {(guide.description || (guide.specializations?.length ?? 0) > 0 || (guide.languages?.length ?? 0) > 0) && (
          <section className="ds-card mb-5">
            <h2 className="ds-label flex items-center gap-2 mb-4">
              <span className="w-4 h-px bg-[var(--accent)]/70" aria-hidden /> О гиде
            </h2>
            {guide.description && (
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-4 whitespace-pre-line">{guide.description}</p>
            )}
            {(guide.specializations?.length ?? 0) > 0 && (
              <div className="mb-3">
                <p className="text-xs text-[var(--text-muted)] mb-1.5 inline-flex items-center gap-1"><Mountain size={12} /> Специализации</p>
                <div className="flex flex-wrap gap-1.5">
                  {guide.specializations!.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1 text-xs bg-[var(--bg-hover)] text-[var(--text-secondary)] px-2 py-0.5 rounded">
                      <Award size={10} className="text-[var(--accent)]" /> {SPEC_LABELS[s] ?? s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(guide.languages?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs text-[var(--text-muted)] mb-1.5 inline-flex items-center gap-1"><Languages size={12} /> Языки</p>
                <div className="flex flex-wrap gap-1.5">
                  {guide.languages!.map((l) => (
                    <span key={l} className="text-xs bg-[var(--bg-hover)] text-[var(--text-secondary)] px-2 py-0.5 rounded">{l}</span>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Контакт */}
        <div className="ds-card flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-[var(--text-secondary)]">Хотите пойти с этим гидом? Свяжитесь до брони — уточните маршрут и опыт.</p>
          {guide.phone ? (
            <a href={`tel:${guide.phone}`} className="ds-btn ds-btn-primary inline-flex items-center gap-2 whitespace-nowrap">
              <Phone size={14} /> Связаться
            </a>
          ) : (
            <Link href="/operators" className="ds-btn ds-btn-primary inline-flex items-center gap-2 whitespace-nowrap">
              <Phone size={14} /> Найти через оператора
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
