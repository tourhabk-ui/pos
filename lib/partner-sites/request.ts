/**
 * Какой сайт отдаёт этот запрос: партнёра на его домене или Ведар (там
 * страница партнёра — предпросмотр под /partner-site/<slug>).
 *
 * За прокси Timeweb заголовок Host до приложения доходит не всегда — правила
 * канона домена в next.config.js по той же причине продублированы через
 * x-forwarded-host. Поэтому сначала x-forwarded-host, потом host.
 */
import type { PartnerSite } from '@/lib/partner-sites/registry';
import { partnerSiteForHost } from '@/lib/partner-sites/registry';

interface HeaderBag {
  get(name: string): string | null;
}

export function requestHost(h: HeaderBag): string | null {
  return h.get('x-forwarded-host') ?? h.get('host');
}

/** Сайт партнёра, если запрос пришёл на его домен; иначе null. */
export function partnerSiteOfRequest(h: HeaderBag): PartnerSite | null {
  return partnerSiteForHost(requestHost(h));
}

export const VEDAR_BASE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru').replace(/\/$/, '');
