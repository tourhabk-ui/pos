/**
 * Сайт партнёра, который отдаёт Ведар (lib/partner-sites/registry): первым —
 * fishingkam.ru «Камчатской рыбалки» (слово владельца 22.10).
 *
 * Это витрина партнёра, а не страница Ведара (§0: «виджет на сайте партнёра —
 * его витрина»): своего имени в шапке, меню, поиска и кнопки SOS Ведара здесь
 * нет, чужих туров нет. Всё содержимое — из базы: профиль партнёра и его живые
 * туры, те же строки, что на /operators/[slug] и в карточках туров. Сайт на
 * Tilda расходился с карточками в ценах, сроках и составе; сайт из той же
 * базы разойтись с ними не может.
 *
 * Чего нет в данных, того нет и на странице (§4.0): без туров — без блока
 * туров, без вопросов — без вопросов. Оплаты нет: приём оплаты на платформе
 * выключен (05.10), заявка — разговор с партнёром.
 *
 * Ссылки на Ведар — абсолютные: на домене партнёра относительный /catalog
 * открыл бы страницу Ведара под чужим адресом.
 */
import Image from 'next/image';
import { Phone, Send, Fish, Home, Calendar, Users, Star, Shield, MapPin, CalendarDays, ArrowUpRight } from 'lucide-react';
import type React from 'react';
import type { PartnerSiteData } from '@/lib/partner-sites/load';
import type { PartnerSiteTourRow } from '@/lib/types/db-rows';
import {
  extractContacts, extractFaq, extractFeatures, extractGallery, extractLegalInfo, extractSeasonInfo,
} from '@/lib/operators/profile-parse';
import { priceUnitLabel } from '@/lib/tours/labels';
import { tourPath } from '@/lib/tours/tour-url';
import { TOUR_PHOTO_POSITION } from '@/lib/tours/photo-focus';
import { OperatorGallery } from '@/components/operator/OperatorGallery';
import { OperatorLegalInfo } from '@/components/operator/OperatorLegalInfo';
import { OperatorLeadForm, PARTNER_SITE_LEAD_SOURCE } from '@/components/operators/OperatorLeadForm';

const FEATURE_ICONS: Record<string, React.ElementType> = { Shield, Fish, Home, Calendar, Users, Star, MapPin, Phone };

/** +79001234567 → «+7 900 123-45-67»; незнакомая форма — как записана. */
function formatPhone(raw: string): string {
  const d = raw.replace(/[^\d+]/g, '');
  const m = d.match(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : raw;
}

export function tourPriceText(t: Pick<PartnerSiteTourRow, 'base_price' | 'price_unit'>): string {
  const price = t.base_price === null ? NaN : Number.parseFloat(t.base_price);
  if (!Number.isFinite(price) || price <= 0) return 'Цена по запросу';
  return `${Math.round(price).toLocaleString('ru-RU')} ₽ ${priceUnitLabel(t.price_unit)}`;
}

function groupText(t: PartnerSiteTourRow): string | null {
  const min = t.min_participants ?? 0;
  const max = t.max_participants ?? 0;
  if (min > 0 && max > 0) return min === max ? `группа ${min} чел.` : `группа ${min}–${max} чел.`;
  if (min > 0) return `группа от ${min} чел.`;
  if (max > 0) return `группа до ${max} чел.`;
  return null;
}

function sameHost(href: string, host: string): boolean {
  try {
    return new URL(href).hostname.replace(/^www\./, '') === host;
  } catch {
    return false;
  }
}

export function PartnerSitePage({ data, host, vedarBase }: {
  data: PartnerSiteData;
  /** Домен сайта партнёра (fishingkam.ru): ссылка «наш сайт» на самом сайте не нужна. */
  host: string;
  /** Адрес Ведара для абсолютных ссылок: https://vedarai.ru. */
  vedarBase: string;
}) {
  const { profile, tours } = data;
  const features = extractFeatures(profile.features);
  const faq = extractFaq(profile.faq);
  const seasons = extractSeasonInfo(profile.season_info);
  const gallery = extractGallery(profile.gallery);
  const contacts = extractContacts(profile.contacts).filter((c) => !(c.href && sameHost(c.href, host)));
  const legal = extractLegalInfo(profile.legal_info);
  const phone = contacts.find((c) => c.phone)?.phone ?? null;
  const hero = profile.hero_image ?? gallery[0] ?? null;
  const year = new Date().getFullYear();

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <header className="sticky top-0 z-40 bg-[var(--bg-card)] border-b border-[var(--border)]">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <a href="#top" className="flex items-center gap-2 min-w-0">
            {profile.logo_image && (
              <span className="relative w-8 h-8 rounded-md overflow-hidden bg-black shrink-0">
                <Image src={profile.logo_image} alt="" fill className="object-contain" sizes="32px" />
              </span>
            )}
            <span className="font-playfair font-bold text-base truncate">{profile.name}</span>
          </a>
          <nav aria-label="Разделы" className="hidden md:flex items-center gap-5 text-sm text-[var(--text-secondary)]">
            {tours.length > 0 && <a href="#tury" className="hover:text-[var(--accent)]">Туры и цены</a>}
            {features.length > 0 && <a href="#baza" className="hover:text-[var(--accent)]">База</a>}
            {faq.length > 0 && <a href="#voprosy" className="hover:text-[var(--accent)]">Вопросы</a>}
            <a href="#kontakty" className="hover:text-[var(--accent)]">Контакты</a>
          </nav>
          <div className="flex items-center gap-2 shrink-0">
            {phone && (
              <a
                href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--ocean)]"
                aria-label={`Позвонить: ${formatPhone(phone)}`}
              >
                <Phone className="w-4 h-4" />
                <span className="hidden sm:inline">{formatPhone(phone)}</span>
              </a>
            )}
            <a href="#zayavka" className="ds-btn ds-btn-primary text-sm" style={{ minHeight: 40 }}>Заявка</a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="relative">
          <div className="relative h-[60vh] min-h-[360px] max-h-[640px] bg-[var(--bg-hover)]">
            {hero && (
              <Image
                src={hero}
                alt={profile.name}
                fill
                priority
                className="object-cover"
                style={{ objectPosition: TOUR_PHOTO_POSITION }}
                sizes="100vw"
              />
            )}
          </div>
          <div className="absolute inset-x-0 bottom-0 px-4 pb-6">
            <div className="max-w-6xl mx-auto">
              <div data-theme="dark" className="fx-glass-dense rounded-2xl p-5 sm:p-7 max-w-2xl">
                <h1 className="font-playfair text-3xl sm:text-5xl font-bold text-[var(--text-primary)]">{profile.name}</h1>
                {profile.short_description && (
                  <p className="mt-3 text-base sm:text-lg text-[var(--text-secondary)]">{profile.short_description}</p>
                )}
                <div className="mt-5 flex flex-wrap gap-3">
                  <a href="#zayavka" className="ds-btn ds-btn-primary inline-flex items-center gap-2">
                    <Send className="w-4 h-4" /> Оставить заявку
                  </a>
                  {tours.length > 0 && (
                    <a href="#tury" className="ds-btn ds-btn-secondary">Туры и цены</a>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="max-w-6xl mx-auto px-4 py-10 space-y-14">
          {profile.description && (
            <section aria-labelledby="o-nas" className="max-w-3xl">
              <h2 id="o-nas" className="font-playfair text-3xl font-bold mb-4">О рыбалке с нами</h2>
              <p className="text-[var(--text-secondary)] leading-relaxed">{profile.description}</p>
            </section>
          )}

          {tours.length > 0 && (
            <section id="tury" aria-labelledby="tury-h" className="scroll-mt-20">
              <h2 id="tury-h" className="font-playfair text-3xl font-bold mb-6">Туры и цены</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {tours.map((t) => {
                  const img = t.photos?.[0] ?? t.tour_image ?? null;
                  const group = groupText(t);
                  return (
                    <article key={t.id} className="ds-card overflow-hidden flex flex-col" aria-labelledby={`tour-${t.id}`}>
                      {img && (
                        <div className="relative h-44">
                          <Image src={img} alt={t.title} fill className="object-cover" style={{ objectPosition: TOUR_PHOTO_POSITION }} sizes="(max-width: 768px) 100vw, 33vw" />
                        </div>
                      )}
                      <div className="p-5 flex flex-col gap-2 flex-1">
                        <h3 id={`tour-${t.id}`} className="font-semibold text-lg leading-snug">{t.title}</h3>
                        {t.season_start && t.season_end && (
                          <p className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                            <CalendarDays className="w-4 h-4 shrink-0" /> {t.season_start} — {t.season_end}
                          </p>
                        )}
                        {t.short_description && <p className="text-sm text-[var(--text-secondary)]">{t.short_description}</p>}
                        <p className="text-lg font-semibold text-[var(--accent)]">{tourPriceText(t)}</p>
                        {group && <p className="text-xs text-[var(--text-muted)]">{group}</p>}
                        {((t.included?.length ?? 0) > 0 || (t.not_included?.length ?? 0) > 0) && (
                          <details className="text-sm">
                            <summary className="cursor-pointer text-[var(--ocean)] py-1">Что входит в цену</summary>
                            {(t.included?.length ?? 0) > 0 && (
                              <ul className="mt-2 space-y-1 text-[var(--text-secondary)]">
                                {t.included!.map((x) => <li key={x}>+ {x}</li>)}
                              </ul>
                            )}
                            {(t.not_included?.length ?? 0) > 0 && (
                              <>
                                <p className="mt-3 text-xs font-semibold text-[var(--text-muted)]">Не входит</p>
                                <ul className="mt-1 space-y-1 text-[var(--text-muted)]">
                                  {t.not_included!.map((x) => <li key={x}>— {x}</li>)}
                                </ul>
                              </>
                            )}
                          </details>
                        )}
                        <div className="mt-auto pt-3 flex flex-col gap-2">
                          <a href="#zayavka" className="ds-btn ds-btn-primary justify-center text-sm" style={{ minHeight: 44 }}>
                            Оставить заявку
                          </a>
                          <a
                            href={`${vedarBase}${tourPath(t)}`}
                            className="inline-flex items-center justify-center gap-1 text-sm text-[var(--ocean)] hover:underline"
                          >
                            Свободные даты на Ведаре <ArrowUpRight className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {features.length > 0 && (
            <section id="baza" aria-labelledby="baza-h" className="scroll-mt-20">
              <h2 id="baza-h" className="font-playfair text-3xl font-bold mb-6">База и рыбалка</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {features.map((f) => {
                  const Icon = (f.icon && FEATURE_ICONS[f.icon]) || Shield;
                  return (
                    <div key={f.title} className="flex gap-3 items-start">
                      <span className="w-10 h-10 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center shrink-0">
                        <Icon className="w-5 h-5 text-[var(--accent)]" />
                      </span>
                      <div>
                        <h3 className="font-semibold">{f.title}</h3>
                        {f.desc && <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">{f.desc}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {seasons.length > 0 && (
            <section aria-labelledby="ryba-h">
              <h2 id="ryba-h" className="font-playfair text-3xl font-bold mb-6">Когда какая рыба</h2>
              <div className="ds-card divide-y divide-[var(--border)]">
                {seasons.map((s) => (
                  <div key={`${s.season}|${s.months}`} className="p-4 grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-1 sm:gap-4">
                    <p className="font-semibold">{s.months}{s.season ? <span className="font-normal text-[var(--text-muted)]"> · {s.season}</span> : null}</p>
                    <p className="text-sm text-[var(--text-secondary)]">{s.fish}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {gallery.length > 1 && (
            <section aria-labelledby="foto-h">
              <h2 id="foto-h" className="font-playfair text-3xl font-bold mb-6">Фотографии</h2>
              <OperatorGallery images={gallery} name={profile.name} />
            </section>
          )}

          {faq.length > 0 && (
            <section id="voprosy" aria-labelledby="voprosy-h" className="scroll-mt-20 max-w-3xl">
              <h2 id="voprosy-h" className="font-playfair text-3xl font-bold mb-6">Частые вопросы</h2>
              <div className="ds-card divide-y divide-[var(--border)]">
                {faq.map((item) => (
                  <details key={item.q} className="p-4">
                    <summary className="cursor-pointer font-semibold">{item.q}</summary>
                    <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">{item.a}</p>
                  </details>
                ))}
              </div>
            </section>
          )}

          <section id="zayavka" aria-labelledby="zayavka-h" className="scroll-mt-20 ds-card p-5 sm:p-7 max-w-3xl">
            <h2 id="zayavka-h" className="font-playfair text-3xl font-bold mb-2">Оставить заявку</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-5">
              Напишите даты, сколько вас и какой тур интересует. Заявка придёт «{profile.name}» — ответят сами, по телефону
              или в мессенджере. Это бесплатно и ни к чему не обязывает.
            </p>
            <OperatorLeadForm partnerSlug={profile.slug} partnerName={profile.name} source={PARTNER_SITE_LEAD_SOURCE} />
          </section>

          <div id="kontakty" className="scroll-mt-20 grid grid-cols-1 lg:grid-cols-2 gap-5">
            {contacts.length > 0 && (
              <section aria-labelledby="kontakty-h" className="ds-card p-5">
                <h2 id="kontakty-h" className="font-playfair text-2xl font-bold mb-4">Контакты</h2>
                <ul className="space-y-3">
                  {contacts.map((c, i) => (
                    <li key={`${c.phone ?? c.href ?? c.address ?? ''}-${i}`} className="text-sm">
                      {(c.name || c.role) && (
                        <p className="font-semibold">{c.name}{c.name && c.role ? ' · ' : ''}{c.role}</p>
                      )}
                      {c.phone && (
                        <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} className="text-[var(--ocean)] hover:underline">
                          {formatPhone(c.phone)}
                        </a>
                      )}
                      {c.href && (
                        <a href={c.href} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)] hover:underline">
                          {c.label ?? c.href}
                        </a>
                      )}
                      {c.address && <p className="text-[var(--text-secondary)]">{c.address}</p>}
                      {c.note && <p className="text-xs text-[var(--text-muted)] mt-0.5">{c.note}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <OperatorLegalInfo
              legal={legal}
              registryNumber={profile.registry_number}
              registryStatus={profile.registry_status}
              registryCheckedAt={profile.registry_checked_at}
            />
          </div>
        </div>
      </main>

      <footer className="border-t border-[var(--border)] bg-[var(--bg-card)]">
        <div className="max-w-6xl mx-auto px-4 py-6 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between text-xs text-[var(--text-muted)]">
          <p>© {year} {profile.name}</p>
          <p>
            Сайт работает на платформе{' '}
            <a href={vedarBase} className="text-[var(--ocean)] hover:underline">Ведар</a>
            {' · '}
            <a href={`${vedarBase}/legal/privacy`} className="text-[var(--ocean)] hover:underline">Политика обработки персональных данных</a>
          </p>
        </div>
      </footer>
    </div>
  );
}
