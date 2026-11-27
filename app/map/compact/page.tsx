import type { Metadata } from 'next';
import Script from 'next/script';
import MapPageClient from '../_MapPageClient';
import { MAX_BRIDGE_SRC } from '@/lib/miniapp/bridge';
import { MAP_PACK_BASE_URL_ENV } from '@/lib/map/pack-source';
import { mapPageProps } from '@/lib/map/map-page-props';

/**
 * Узкий вход в карту обстановки — для мини-приложения MAX (задача владельца
 * 27.11). Та же `/map` (тот же клиент, те же слои и ссылки `?place=`,
 * `?show=safety`, payload `WebAppStartParam`), без обвязки сайта: нижней
 * навигации, плавающего помощника, указателя мест, кнопки «моё место» и
 * ссылок в кабинет. Геолокации здесь нет (решение владельца 27.11).
 *
 * В поиск не идёт: это вход приложения, его страница для людей и обходчиков —
 * `/map`.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Карта обстановки Камчатки',
  alternates: { canonical: '/map' },
  robots: { index: false, follow: true },
};

export default async function MapCompactPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const mapPackBaseUrl = process.env[MAP_PACK_BASE_URL_ENV] || null;
  const { focus, openSafety } = await mapPageProps(searchParams);
  // Мост MAX — только здесь (CSP разрешает его только этому адресу,
  // next.config.js): по нему кнопка SOS открывает /sos во внешнем браузере.
  return (
    <>
      <Script src={MAX_BRIDGE_SRC} strategy="afterInteractive" />
      <MapPageClient mapPackBaseUrl={mapPackBaseUrl} focus={focus} openSafety={openSafety} compact />
    </>
  );
}
