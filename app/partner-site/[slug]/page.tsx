/**
 * Сайт партнёра, который отдаёт Ведар (lib/partner-sites/registry).
 *
 * На домене партнёра (fishingkam.ru) сюда переписывает next.config.js —
 * посетитель видит адрес https://fishingkam.ru/. На vedarai.ru тот же путь —
 * предпросмотр для владельца: закрыт от поисковиков, canonical ведёт на домен
 * партнёра, и дубля у сайта нет.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/JsonLd';
import { defaultOgImages } from '@/lib/seo/og-image';
import { PartnerSitePage } from '@/components/partner-site/PartnerSitePage';
import { loadPartnerSite } from '@/lib/partner-sites/load';
import { partnerSiteBySlug, partnerSiteUrl } from '@/lib/partner-sites/registry';
import { partnerSiteOfRequest, VEDAR_BASE } from '@/lib/partner-sites/request';
import { extractContacts, extractGallery, extractLegalInfo } from '@/lib/operators/profile-parse';

export const dynamic = 'force-dynamic';

type Params = { slug: string };

function absolute(site: { host: string }, src: string | null): string | null {
  if (!src) return null;
  if (/^https?:\/\//.test(src)) return src;
  return `https://${site.host}${src.startsWith('/') ? '' : '/'}${src}`;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const site = partnerSiteBySlug(slug);
  if (!site) return { title: 'Сайт не найден', robots: { index: false, follow: false } };
  // Индексируется только на своём домене: на vedarai.ru это предпросмотр.
  const onOwnDomain = partnerSiteOfRequest(await headers())?.slug === site.slug;
  const url = partnerSiteUrl(site);
  const data = await loadPartnerSite(site.slug);
  const logo = data?.profile.logo_image ?? null;
  const ogImage = data ? absolute(site, data.profile.hero_image ?? extractGallery(data.profile.gallery)[0] ?? null) : null;
  return {
    // absolute: шаблон «… | Ведар» корневого layout к сайту партнёра не относится.
    title: { absolute: site.title },
    description: site.description,
    alternates: { canonical: url },
    robots: onOwnDomain ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      title: site.title, description: site.description, url, type: 'website', locale: 'ru_RU', siteName: site.host,
      // Снимок партнёра: превью ссылки — его сайт. Без снимка — общая
      // картинка, а не пустое превью (сторож og-image-everywhere).
      images: ogImage ? [{ url: ogImage }] : defaultOgImages(),
    },
    // Не приложение Ведара: без его манифеста браузер не предложит
    // «установить Ведар» на сайте партнёра; значок вкладки — логотип партнёра.
    manifest: null,
    ...(logo ? { icons: { icon: logo, apple: logo } } : {}),
  };
}

export default async function PartnerSiteRoute({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const site = partnerSiteBySlug(slug);
  if (!site) notFound();
  const data = await loadPartnerSite(site.slug);
  if (!data) notFound();

  const { profile } = data;
  const legal = extractLegalInfo(profile.legal_info);
  const legalObj = legal && typeof legal === 'object' ? legal : null;
  const phone = extractContacts(profile.contacts).find((c) => c.phone)?.phone ?? null;
  const logo = absolute(site, profile.logo_image);
  const image = absolute(site, profile.hero_image ?? extractGallery(profile.gallery)[0] ?? null);
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: profile.name,
    url: partnerSiteUrl(site),
    ...(legalObj?.companyName ? { legalName: legalObj.companyName } : {}),
    ...(legalObj?.inn ? { taxID: legalObj.inn } : {}),
    ...(legalObj?.address ? { address: { '@type': 'PostalAddress', addressCountry: 'RU', streetAddress: legalObj.address } } : {}),
    ...(phone ? { telephone: phone } : {}),
    ...(logo ? { logo } : {}),
    ...(image ? { image } : {}),
  };

  return (
    <>
      <JsonLd data={org} />
      <PartnerSitePage data={data} host={site.host} vedarBase={VEDAR_BASE} />
    </>
  );
}
