import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { ChevronRight, MapPin, ShieldCheck, BadgeCheck, Fish, Home, Calendar, Users, Star, Shield, Phone, Send } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { OperatorRating } from '@/components/operator/OperatorRating';
import { query } from '@/lib/database';
import type { OperatorProfileRow, OperatorPageTourRow } from '@/lib/types/db-rows';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { priceUnitLabel } from '@/lib/tours/labels';
import {
  extractServices, extractFeatures, extractContacts, extractFaq,
  extractGallery, extractLegalInfo,
} from '@/lib/operators/profile-parse';
import { TOUR_PHOTO_POSITION } from '@/lib/tours/photo-focus';
import { tourPath } from '@/lib/tours/tour-url';
import { defaultOgImages } from '@/lib/seo/og-image';
import { operatorMetaDescription } from '@/lib/seo/operator-meta';
import { brandedTitle, fitTitleRequired, OPERATOR_TITLE_TAILS } from '@/lib/seo/title-fit';
import { metaDescription } from '@/lib/seo/meta-description';
import { operatorOrgId } from '@/lib/seo/tour-structured-data';
import { JsonLd } from '@/components/seo/JsonLd';
import { OperatorGallery } from '@/components/operator/OperatorGallery';
import { OperatorLegalInfo } from '@/components/operator/OperatorLegalInfo';
import { OperatorLeadForm } from '@/components/operators/OperatorLeadForm';
import { carrierPagePath } from '@/lib/transfers/charter-format';
import { rentalPagePath } from '@/lib/rental/rental-format';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

type Params = { slug: string };

function parseScore(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCount(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Подпись категории на карточке: сырое `transfer` человеку ничего не говорит. Прочие — как в базе. */
// prod-check 117 (13.10): бейдж в герое печатал сырое «operator» — ключ категории
// вместо слова. Неизвестный ключ по-прежнему печатается как есть, не прячется.
const CATEGORY_LABEL: Record<string, string> = {
  operator: 'Туроператор', transfer: 'Перевозчик', guide: 'Гид', stay: 'Жильё', gear: 'Прокат', agent: 'Агент',
  cars: 'Прокат автомобилей',
};

const ICON_MAP: Record<string, React.ElementType> = {
  Shield, Fish, Home, Calendar, Users, Star, MapPin, Phone,
};

// ─────────────────────────────────────────────────────────────────────────────

async function getOperatorProfile(slug: string): Promise<OperatorProfileRow | null> {
  const aliases = slug === 'fishingkam'
    ? ['fishingkam', 'kamchatskaya-rybalka']
    : slug === 'kamchatskaya-rybalka'
      ? ['kamchatskaya-rybalka', 'fishingkam']
      : [slug];

  const result = await query<OperatorProfileRow>(
    `SELECT id, slug, name, category, description, short_description,
            hero_image, logo_image, gallery, services, features, faq, season_info,
            reviews_data, contacts, location, legal_info, contact,
            rating::text, review_count::text, is_verified,
            registry_status, registry_number,
            to_char(registry_checked_at AT TIME ZONE 'Asia/Kamchatka', 'DD.MM.YYYY') AS registry_checked_at,
            created_at::text
     FROM partners
     WHERE slug = ANY($1) AND is_public = TRUE
     ORDER BY CASE
       WHEN slug = $2 THEN 0
       WHEN slug = 'kamchatskaya-rybalka' THEN 1
       WHEN slug = 'fishingkam' THEN 2
       ELSE 3
     END
     LIMIT 1`,
    [aliases, slug]
  );

  return result.rows[0] ?? null;
}

/**
 * Туры оператора на витрине. До 29.09 страница оператора не показывала его
 * туров вовсе: турист видел описание базы и цены «от», но дойти отсюда до
 * брони было нельзя. Шлюз витрины — общий (`publicTourSql`): черновик и
 * снятый с витрины тур здесь не появляются.
 */
async function getOperatorTours(operatorId: string): Promise<OperatorPageTourRow[]> {
  const result = await query<OperatorPageTourRow>(
    `SELECT ot.id::text AS id, ot.slug, ot.title, ot.short_description,
            ot.base_price::text AS base_price, ot.price_unit,
            ot.duration_type, ot.multi_day_count,
            to_char(ot.season_start, 'DD.MM.YYYY') AS season_start,
            to_char(ot.season_end, 'DD.MM.YYYY') AS season_end,
            ot.photos, ot.tour_image
       FROM operator_tours ot
      WHERE ot.operator_id::text = $1::text AND ${publicTourSql('ot')}
      ORDER BY (ot.pinned_at IS NULL), ot.pinned_at, ot.season_start NULLS LAST, ot.id`,
    [operatorId]
  );
  return result.rows;
}

/** +79001234567 → «+7 900 123-45-67»; незнакомая форма — как записана. */
function formatPhone(raw: string): string {
  const d = raw.replace(/[^\d+]/g, '');
  const m = d.match(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : raw;
}

function tourPriceText(t: OperatorPageTourRow): string {
  const price = t.base_price === null ? NaN : Number.parseFloat(t.base_price);
  if (!Number.isFinite(price) || price <= 0) return 'Цена по запросу';
  return `${Math.round(price).toLocaleString('ru-RU')} ₽ ${priceUnitLabel(t.price_unit)}`;
}

function tourDurationText(t: OperatorPageTourRow): string | null {
  if (t.duration_type === 'multi_day' && t.multi_day_count) {
    const d = t.multi_day_count;
    return `${d} ${d % 10 === 1 && d % 100 !== 11 ? 'день' : d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 10 || d % 100 >= 20) ? 'дня' : 'дней'}`;
  }
  if (t.duration_type === 'day') return '1 день';
  if (t.duration_type === 'half_day') return 'Полдня';
  return null;
}

export async function generateMetadata(
  { params }: { params: Promise<Params> }
): Promise<Metadata> {
  const { slug } = await params;
  const profile = await getOperatorProfile(slug);

  if (!profile) {
    return {
      title: 'Оператор не найден',
      robots: { index: false, follow: true },
    };
  }

  const title = fitTitleRequired(profile.name, OPERATOR_TITLE_TAILS);
  const description = operatorMetaDescription(profile);

  return {
    title: brandedTitle(title),
    description,
    alternates: { canonical: `${SITE}/operators/${profile.slug}` },
    openGraph: {
      title,
      description,
      url: `${SITE}/operators/${profile.slug}`,
      siteName: 'Ведар',
      locale: 'ru_RU',
      type: 'website',
      // Нет своего снимка — картинка сайта: `undefined` снимал og:image вовсе
      // (аудит 01.10, /operators/kamchatka-rafting).
      images: profile.hero_image ? [{ url: profile.hero_image }] : defaultOgImages(),
    },
  };
}

export default async function OperatorProfilePage(
  { params }: { params: Promise<Params> }
) {
  const { slug } = await params;

  if (!slug || slug.length > 100) notFound();

  const profile = await getOperatorProfile(slug);
  if (!profile) notFound();
  // Перевозчик — не туроператор: у него своя страница по стандарту карточки
  // трансфера (13.10). Здесь он открывался шаблоном туроператора — с подписью
  // «Проверенный оператор», FAQ про туры и без формы заказа машины. Старые
  // ссылки и короткий адрес vedarai.ru/<slug> (rewrite сюда) ведут туда.
  if (profile.category === 'transfer') permanentRedirect(carrierPagePath(profile.slug));
  // Прокат автомобилей — тоже не туроператор (23.10): машина без водителя за
  // сутки, своя страница с прайсом и заявкой.
  if (profile.category === 'cars') permanentRedirect(rentalPagePath(profile.slug));

  const services  = extractServices(profile.services);
  const features  = extractFeatures(profile.features);
  const contacts  = extractContacts(profile.contacts);
  const legalInfo = extractLegalInfo(profile.legal_info);
  const rating     = parseScore(profile.rating);
  const reviewCount = parseCount(profile.review_count);
  // Все снимки: сетка показывает шесть, просмотрщик листает все (OperatorGallery).
  const gallery   = extractGallery(profile.gallery);
  const faq       = extractFaq(profile.faq);

  const heroImage = profile.hero_image ?? gallery[0] ?? null;
  const tours = await getOperatorTours(profile.id);

  // Организация оператора — тот же @id, на который ссылаются provider и
  // seller в разметке его туров (lib/seo/tour-structured-data, аудит 01.10).
  const pageUrl = `${SITE}/operators/${profile.slug}`;
  // Первое НЕПУСТОЕ: `??` пропускал '' и оставлял организацию без описания (Н14).
  const orgDescription = [profile.short_description, profile.description].map((t) => (t ?? '').trim()).find(Boolean) ?? null;
  const orgJsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': operatorOrgId(SITE, profile.slug),
    name: profile.name,
    url: pageUrl,
    ...(orgDescription ? { description: metaDescription(orgDescription, 500) } : {}),
    ...(profile.logo_image
      ? { logo: profile.logo_image.startsWith('http') ? profile.logo_image : `${SITE}${profile.logo_image.startsWith('/') ? '' : '/'}${profile.logo_image}` }
      : {}),
  };

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <JsonLd data={orgJsonLd} />
      <Header />
      <main className="pt-16">
        <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Link href="/" className="hover:text-[var(--accent)]">Главная</Link>
            <ChevronRight className="w-3.5 h-3.5" />
            <Link href="/operators" className="hover:text-[var(--accent)]">Операторы</Link>
            <ChevronRight className="w-3.5 h-3.5" />
            <span>{profile.name}</span>
          </div>

          {/* Hero */}
          <section className="ds-card p-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                {profile.logo_image && (
                  <div className="relative w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden mb-3 bg-black border border-[var(--border)]">
                    <Image src={profile.logo_image} alt={`Логотип ${profile.name}`} fill className="object-contain" sizes="80px" />
                  </div>
                )}
                <h1 className="font-playfair text-3xl sm:text-4xl font-bold mb-3">{profile.name}</h1>
                <div className="flex flex-wrap items-center gap-3 mb-4">
                  {profile.category && <span className="ds-badge">{CATEGORY_LABEL[profile.category] ?? profile.category}</span>}
                  {profile.is_verified && (
                    <span className="inline-flex items-center gap-1 text-sm text-[var(--success)]">
                      <ShieldCheck className="w-4 h-4" /> Проверенный оператор
                    </span>
                  )}
                  {profile.registry_status === 'verified' && (
                    <span
                      className="inline-flex items-center gap-1 text-sm text-[var(--ocean)]"
                      title={
                        profile.registry_number
                          ? `Реестровый номер: ${profile.registry_number}`
                          : 'Найден в официальном реестре туроператоров visitkamchatka.ru'
                      }
                    >
                      <BadgeCheck className="w-4 h-4" /> В официальном реестре
                    </span>
                  )}
                </div>
                <div className="mb-5">
                  <OperatorRating rating={rating} reviewCount={reviewCount} size="lg" trend={null} />
                </div>
                {profile.short_description && (
                  <p className="text-[var(--text-secondary)] text-base mb-3">{profile.short_description}</p>
                )}
                {profile.description && (
                  <p className="text-[var(--text-secondary)] leading-relaxed">{profile.description}</p>
                )}
                {/* Заявка-разговор, не бронь: бронь живёт на карточке тура (владелец 02.10). */}
                <a href="#lead-form" className="ds-btn ds-btn-primary inline-flex items-center gap-2 mt-5">
                  <Send className="w-4 h-4" /> Написать оператору
                </a>
              </div>
              <div>
                <div className="relative w-full h-64 sm:h-80 rounded-lg overflow-hidden bg-[var(--bg-hover)] border border-[var(--border)]">
                  {heroImage ? (
                    <Image src={heroImage} alt={profile.name} fill className="object-cover" style={{ objectPosition: TOUR_PHOTO_POSITION }} sizes="(max-width: 1024px) 100vw, 50vw" priority />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[var(--text-muted)]">
                      <MapPin className="w-10 h-10" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Gallery */}
          {gallery.length > 1 && (
            <section className="ds-card p-5">
              <h2 className="font-playfair text-2xl font-bold mb-4">Галерея</h2>
              {/* Снимки открываются (владелец 09.10: «галерея не открывается»). */}
              <OperatorGallery images={gallery} name={profile.name} />
            </section>
          )}

          {/* Tours */}
          {tours.length > 0 && (
            <section className="ds-card p-5">
              <h2 className="font-playfair text-2xl font-bold mb-4">Туры</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {tours.map(t => {
                  const img = t.photos?.[0] ?? t.tour_image ?? null;
                  const duration = tourDurationText(t);
                  // Карточка — не одна большая ссылка: у каждого тура своя
                  // кнопка «Забронировать» (владелец 02.10: «нет кнопки
                  // забронировать на каждом туре»). Ведёт на единственную
                  // форму брони карточки тура (#booking, §11); вкладывать
                  // <a> в <a> нельзя, поэтому обёртка — div.
                  return (
                    <div
                      key={t.id}
                      className="group bg-[var(--bg-hover)] rounded-lg overflow-hidden flex flex-col hover:ring-1 hover:ring-[var(--accent)] transition-all duration-200"
                    >
                      <Link href={tourPath(t)} className="flex flex-col flex-1">
                        {img && (
                          <div className="relative h-36">
                            <Image src={img} alt={t.title} fill className="object-cover" style={{ objectPosition: TOUR_PHOTO_POSITION }} sizes="(max-width: 640px) 100vw, 33vw" />
                          </div>
                        )}
                        <div className="p-4 pb-2 space-y-1.5 flex-1">
                          <p className="font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)]">{t.title}</p>
                          {t.season_start && t.season_end && (
                            <p className="text-xs text-[var(--text-muted)]">{t.season_start} — {t.season_end}{duration ? ` · ${duration}` : ''}</p>
                          )}
                          {t.short_description && (
                            <p className="text-sm text-[var(--text-secondary)] line-clamp-2">{t.short_description}</p>
                          )}
                          <p className="text-sm font-medium text-[var(--accent)]">{tourPriceText(t)}</p>
                        </div>
                      </Link>
                      <div className="px-4 pb-4">
                        <Link
                          href={`${tourPath(t)}#booking`}
                          className="ds-btn ds-btn-primary w-full justify-center text-sm"
                          style={{ minHeight: 44 }}
                          aria-label={`Отправить заявку: ${t.title}`}
                        >
                          Отправить заявку
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Services */}
          {services.length > 0 && (
            <section className="ds-card p-5">
              <h2 className="font-playfair text-2xl font-bold mb-4">Услуги</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {services.map((s, i) => (
                  <div key={i} className="bg-[var(--bg-hover)] rounded-lg p-4 space-y-2">
                    <p className="font-semibold text-[var(--text-primary)]">{s.title}</p>
                    {s.desc && <p className="text-sm text-[var(--text-secondary)]">{s.desc}</p>}
                    {s.prices && (
                      <div className="space-y-0.5">
                        {Object.entries(s.prices).map(([k, v]) => (
                          <p key={k} className="text-xs text-[var(--text-muted)]">
                            <span className="capitalize">{k === 'summer' ? 'Лето' : k === 'winter' ? 'Зима' : k}:</span>{' '}
                            <span className="font-medium text-[var(--accent)]">{v}</span>
                          </p>
                        ))}
                      </div>
                    )}
                    {s.includes && s.includes.length > 0 && (
                      <ul className="space-y-0.5">
                        {s.includes.map((inc, j) => (
                          <li key={j} className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                            <span className="w-1 h-1 rounded-full bg-[var(--accent)] flex-shrink-0" />
                            {inc}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Features */}
          {features.length > 0 && (
            <section className="ds-card p-5">
              <h2 className="font-playfair text-2xl font-bold mb-4">Особенности</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {features.map((f, i) => {
                  const Icon = (f.icon && ICON_MAP[f.icon]) ? ICON_MAP[f.icon] : Shield;
                  return (
                    <div key={i} className="flex gap-3 items-start">
                      <div className="w-9 h-9 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center flex-shrink-0">
                        <Icon className="w-4 h-4 text-[var(--accent)]" />
                      </div>
                      <div>
                        <p className="font-semibold text-[var(--text-primary)]">{f.title}</p>
                        {f.desc && <p className="text-sm text-[var(--text-secondary)] mt-0.5">{f.desc}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* FAQ */}
          {faq.length > 0 && (
            <section className="ds-card p-5">
              <h2 className="font-playfair text-2xl font-bold mb-4">Частые вопросы</h2>
              <div className="space-y-4">
                {faq.map((item, i) => (
                  <div key={i} className="border-b border-[var(--border)] pb-4 last:border-0 last:pb-0">
                    <p className="font-semibold text-[var(--text-primary)] mb-1">{item.q}</p>
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{item.a}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Lead form — заявка уходит в ящик этого оператора (владелец 13.10: «форму можно») */}
          <section id="lead-form" className="ds-card p-5 scroll-mt-24">
            <h2 className="font-playfair text-2xl font-bold mb-1">Написать оператору</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-4">
              Заявка попадёт в кабинет оператора «{profile.name}» на Ведаре. Ответит он сам — по телефону или в мессенджере.
            </p>
            <OperatorLeadForm partnerSlug={profile.slug} partnerName={profile.name} />
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Contacts */}
            {contacts.length > 0 && (
              <section className="ds-card p-5">
                <h2 className="font-playfair text-2xl font-bold mb-4">Контакты</h2>
                <div className="space-y-3">
                  {contacts.map((c, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[var(--ocean)]/10 flex items-center justify-center flex-shrink-0">
                        <Phone className="w-3.5 h-3.5 text-[var(--ocean)]" />
                      </div>
                      <div>
                        {(c.name || c.role) && (
                          <p className="font-semibold text-sm text-[var(--text-primary)]">
                            {c.name}{c.name && c.role ? ' · ' : ''}{c.role}
                          </p>
                        )}
                        {c.phone && (
                          <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} className="text-sm text-[var(--ocean)] hover:underline">
                            {formatPhone(c.phone)}
                          </a>
                        )}
                        {c.href && (
                          <a
                            href={c.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-[var(--ocean)] hover:underline"
                          >
                            {c.label ?? c.href}
                          </a>
                        )}
                        {c.address && <p className="text-xs text-[var(--text-muted)] mt-0.5">{c.address}</p>}
                        {c.note && <p className="text-xs text-[var(--text-muted)] mt-0.5">{c.note}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Legal: реквизиты и номер в реестре туроператоров с тем, сверен ли он */}
            <OperatorLegalInfo
              legal={legalInfo}
              registryNumber={profile.registry_number}
              registryStatus={profile.registry_status}
              registryCheckedAt={profile.registry_checked_at}
            />
          </div>

        </div>
      </main>
      <Footer />
    </div>
  );
}
