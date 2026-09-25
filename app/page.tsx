import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { pool } from '@/lib/db-pool'
import { getCurrentSafetyStatus } from '@/lib/safety/current-status'
import { Header } from '@/components/layout/Header'
import { HeroStatus, type SafetyStatusData } from '@/components/homepage/HeroStatus'
import { HOME_CONTAINER, HOME_SECTION } from '@/lib/home/desktop-layout'
import { FeaturedTour } from '@/components/homepage/FeaturedTour'
import { LiveOnTrails } from '@/components/homepage/LiveOnTrails'
import { StatsBand, type PlatformStats } from '@/components/homepage/StatsBand'
import { KuzmichBriefing } from '@/components/homepage/KuzmichBriefing'
import { BentoSection } from '@/components/homepage/BentoSection'
import { EditorialSection } from '@/components/homepage/EditorialSection'
import { MessengerAgentsSection } from '@/components/homepage/MessengerAgentsSection'
import { Footer } from '@/components/layout/Footer'
import { OnSiteBanner } from '@/components/geo/OnSiteBanner'
import { HomeMapPreviewLazy } from '@/components/homepage/HomeMapPreviewLazy'
import { SectionErrorBoundary } from '@/components/shared/SectionErrorBoundary'
import { MoodEntry } from '@/components/homepage/MoodEntry'
import { SeasonNow } from '@/components/homepage/SeasonNow'
import BottomNav from '@/components/shared/BottomNav'
import HomeV8Client from './_home/_HomeV8Client'
import { getHomeV8Data, fetchPlates } from './_home/data'
import { homeTreeFor } from '@/lib/home/device-tree'
import { TourGrid } from '@/components/homepage/TourGrid'
import { getPlatformCounts } from '@/lib/stats/platform-counts'

export const dynamic = 'force-dynamic'

/**
 * SOS — единственная реализация на всю платформу (components/shared/EmergencyAction),
 * и с 10.09 она живёт в общей шапке (Header, §2). Раньше здесь висела своя
 * плавающая кнопка `components/shared/SOSButton` (уводила сразу на /emergency,
 * тогда как везде SOS ведёт на /sos и падает на /emergency только офлайн), потом
 * — плавающий EmergencyAction в левом нижнем углу. Второй экземпляр рядом с
 * шапкой — две кнопки одного действия на одном экране (#887, #1775).
 */

async function getSafetyStatus(): Promise<SafetyStatusData | null> {
  try {
    // Обстановка — из общего правила (lib/safety/current-status.ts): до
    // 17.09 здесь лежала дословная копия его SQL с подписью «КБГС РАН»
    // константой, и на паводок от МЧС главная отвечала именем сейсмологов.
    // Своей остаётся только свежесть: главной важно, когда крон ingest
    // последний раз что-то записал (MAX(created_at) по всем записям,
    // включая истёкшие; null = крон ни разу не запускался), а не когда
    // обновились реалтайм-данные точек.
    const [status, lastIngestRes] = await Promise.all([
      getCurrentSafetyStatus(),
      pool.query<{ last_ingest: string | null }>(`
        SELECT MAX(created_at)::text AS last_ingest FROM external_alerts
      `),
    ]);
    if (!status) return null;
    return { ...status, dataUpdatedAt: lastIngestRes.rows[0]?.last_ingest ?? null };
  } catch {
    return null;
  }
}

export const metadata: Metadata = {
  title: 'Ведар — помощник и планировщик путешествия по Камчатке',
  description: 'Ведар помогает спланировать честное и безопасное путешествие по Камчатке.',
  openGraph: {
    title: 'Ведар — Туры на Камчатку',
    description: 'Маршруты, советы, Кузьмич, проверенные операторы.',
    images: [{ url: '/images/hero/hero-light.jpeg', width: 1200, height: 630, alt: 'Камчатка' }],
    type: 'website', locale: 'ru_RU', siteName: 'Ведар',
  },
  twitter: { card: 'summary_large_image', title: 'Ведар', images: ['/images/hero/hero-light.jpeg'] },
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
}

export default async function Page() {
  // Раньше оба дерева (мобайл v8 + десктоп-стек) рендерились и гидрировались на
  // ЛЮБОМ устройстве через CSS `hidden` — display:none прячет, но JS всё равно
  // качается и гидрируется. Теперь сервер по User-Agent рендерит ТОЛЬКО нужное
  // дерево: телефон не тянет десктоп-секции, десктоп не тянет v8. Страница уже
  // force-dynamic, так что UA читается на каждый запрос без проблем с кэшем.
  //
  // Боты — ВСЕГДА десктоп (SEO): Google/Yandex индексируют mobile-first, и лёгкое
  // v8-дерево лишило бы их editorial/stats/маршрутов — весь SSR-SEO Шага 3.
  // Неоднозначный UA → десктоп (безопасный дефолт: полный, SEO-богатый лейаут).
  // Какое дерево — решает lib/home/device-tree (чистая функция со сторожем):
  // маркеры называют краулеров, а не приложения — встроенный браузер
  // Telegram-Android и приложение Яндекса это люди с телефоном (#43).
  const isMobile = homeTreeFor((await headers()).get('user-agent')) === 'mobile';

  // ── Мобильное дерево: только v8, только для телефонов ──────────────
  if (isMobile) {
    const homeData = await getHomeV8Data();
    return (
      <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
        <OnSiteBanner />
        <main className="flex-1">
          {/* Новая Главная v8 «Воронка» — фото-герой, радар безопасности,
              карусель, стеклянные «Стихии», реальная сейсмика. Своя навигация и SOS. */}
          <HomeV8Client data={homeData} />
        </main>
      </div>
    );
  }

  // ── Десктоп-дерево (и все боты/SEO): единый источник цифр ──────────
  // Витрина туров — та же выборка, что у телефона (fetchPlates): порядок,
  // фильтр живого тура и правило сезона одни на оба дерева. Отказ fetchPlates
  // пишет в лог сам и отдаёт [] — блоки туров тогда честно не рисуются.
  const [safety, counts, plates] = await Promise.all([
    getSafetyStatus(), getPlatformCounts().catch(() => null), fetchPlates(),
  ]);
  const platformStats: PlatformStats | null = counts
    ? { routes: counts.routes, places: counts.places, mchsRoutes: counts.mchsRoutes, safetyProfiles: counts.safetyProfiles }
    : null;
  const fetchedAt = new Date().toISOString();

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <OnSiteBanner />
      <main className="flex-1 pt-[56px] pb-16 md:pb-0">

        {/* Одна сетка (lib/home/desktop-layout, 25.09): у каждой секции тот же
            левый край и тот же ритм. «Истории» и бегущая строка — мобильные
            приёмы — с десктопа сняты; цифры встали статичной полосой под
            героем. */}
        <HeroStatus safety={safety} fetchedAt={fetchedAt} />

        {/* Платформа в цифрах — сразу под героем: довод «почему нам верить» */}
        <StatsBand stats={platformStats} />

        {/* Туры сезона — первый тур витрины крупно, остальные сеткой, последняя
            клетка — заявка (#33). Один источник — fetchPlates, второй выборки нет. */}
        <SectionErrorBoundary>
          <FeaturedTour tour={plates[0] ?? null} total={plates.length} />
        </SectionErrorBoundary>
        {plates.length > 0 && <TourGrid plates={plates.slice(1)} />}

        {/* Mood/vibe entry — emotional starting point */}
        <MoodEntry />

        {/* Event-driven travel, пилот на рыбе (issue #1421) — не рендерится в межсезонье */}
        <SeasonNow />

        {/* Кузьмич одним блоком: живые счётчики (при нулях их нет, #36/#40),
            обстановка и туры сезона из той же витрины, каналы связи. */}
        <div className="pt-4 pb-12">
          <LiveOnTrails />
          <SectionErrorBoundary>
            <KuzmichBriefing tours={plates.filter((p) => p.availability !== 'season_over').slice(0, 3).map((p) => ({ id: p.id, title: p.title }))} />
          </SectionErrorBoundary>
          <div className={HOME_CONTAINER}>
            <MessengerAgentsSection />
          </div>
        </div>

        {/* Explore by element — 6 categories */}
        <BentoSection />

        {/* Editorial strip — цифры из единого источника, не хардкод */}
        <EditorialSection mchsRoutes={counts?.mchsRoutes ?? null} safetyProfiles={counts?.safetyProfiles ?? null} />

        {/* Map preview — lazy, в общей сетке */}
        <SectionErrorBoundary>
          <div className={`${HOME_CONTAINER} ${HOME_SECTION}`}>
            <div className="rounded-lg overflow-hidden border border-[var(--border)] h-[380px] md:h-[440px]">
              <HomeMapPreviewLazy />
            </div>
          </div>
        </SectionErrorBoundary>

      </main>
      {/* Футер — только desktop (CLAUDE.md §2); на мобильном — своя нижняя навигация v8 */}
      {/* hidden md:block: это дерево получает и телефон с неопознанным UA, а
          футер из десятков ссылок на телефоне — 2000 пикселей (#43). */}
      <div className="hidden md:block">
        <Footer />
      </div>
      {/* §2/§10.09 (issue #1839): это дерево рендерится не только настоящему
          десктопу, но и любому UA, который серверная эвристика выше не
          распознала как телефон (неоднозначный UA — безопасный дефолт).
          BottomNav сам скрывает себя на десктопных ширинах через `md:hidden`
          (тот же приём, что в HubLayout) — значит рендерить его здесь
          безусловно, а не полагаться ещё раз на UA-нюх. Так навигация
          остаётся единой на ВСЕХ экранах, как обещает §2, а не только там,
          где UA-строка распозналась правильно. */}
      <BottomNav activePath="/" />
    </div>
  );
}
