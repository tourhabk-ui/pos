import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Header } from '@/components/layout/Header'
import { HOME_CONTAINER } from '@/lib/home/desktop-layout'
import { Footer } from '@/components/layout/Footer'
import { OnSiteBanner } from '@/components/geo/OnSiteBanner'
import { SectionErrorBoundary } from '@/components/shared/SectionErrorBoundary'
import BottomNav from '@/components/shared/BottomNav'
import HomeV8Client from './_home/_HomeV8Client'
import { getHomeV8Data, fetchPlates } from './_home/data'
import { homeTreeFor } from '@/lib/home/device-tree'
import { queryCatalogSummaryForPage } from '@/lib/search'
import { loadDeskBrief } from '@/lib/home/desk-brief'
import { DeskHero } from '@/components/homepage/desk/DeskHero'
import { DeskPlanChanges } from '@/components/homepage/desk/DeskPlanChanges'
import { DeskVolcanoBoard } from '@/components/homepage/desk/DeskVolcanoBoard'
import { DeskTours } from '@/components/homepage/desk/DeskTours'
import { DeskHelp } from '@/components/homepage/desk/DeskHelp'
import { DeskAbout } from '@/components/homepage/desk/DeskAbout'
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

// Заголовок и описание называют спрос (туры, маршруты, вулканы, гейзеры,
// источники), а не только роль сервиса: прежние 54 и 73 знака не содержали
// слова «туры» вовсе (аудит SEO 29.09, вечер). Точная фраза «Туры на Камчатку»
// остаётся за /catalog и /plans — главная не начинает title с неё же.
// Без цифр и года: «от N ₽» в статичном описании устареет молча, год — через
// три месяца (§4.0); без «проверенных»: листинг не фильтрует по проверке.
// H1 героя — отдельное решение владельца 14.08, его здесь не трогаем.
// Сторож: tests/unit/seo-audit-2909-evening.test.ts.
const HOME_TITLE = 'Туры и маршруты по Камчатке — Ведар, планировщик поездки';
const HOME_DESCRIPTION = 'Туры на Камчатку, маршруты к вулканам, гейзерам и термальным источникам, рыбалка. Статус безопасности на сегодня, офлайн-карта и SOS.';

export const metadata: Metadata = {
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  openGraph: {
    url: '/',
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [{ url: '/images/hero/hero-light.jpeg', width: 1024, height: 1024, alt: 'Камчатка' }],
    type: 'website', locale: 'ru_RU', siteName: 'Ведар',
  },
  twitter: { card: 'summary_large_image', title: HOME_TITLE, description: HOME_DESCRIPTION, images: ['/images/hero/hero-light.jpeg'] },
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

  // ── Десктоп-дерево (и все боты/SEO): «Сводка дня» (доска 30.09) ───────
  // Порядок доски «Десктоп — сводка дня»: сводка поверх фото → что меняет
  // план и табло вулканов → можно поехать → Кузьмич и подготовка без связи →
  // о Ведаре и остальные разделы.
  // Сводка — та же, что уходит гидам и что говорит Кузьмич (lib/svodka);
  // витрина туров — та же, что у телефона (fetchPlates): порядок, фильтр
  // живого тура и правило сезона одни на оба дерева.
  const [brief, plates, catalogSummary, counts] = await Promise.all([
    loadDeskBrief(),
    fetchPlates(),
    // Счётчик «Все туры» — из сводки каталога, не из длины витрины (§4.0:
    // не смогли посчитать — числа нет, отказ в логе).
    queryCatalogSummaryForPage().catch((e: unknown) => {
      console.error('[home] сводка каталога не получена', {
        code: (e as { code?: string })?.code, message: e instanceof Error ? e.message : String(e),
      });
      return null;
    }),
    // Цифры «О Ведаре» — тот же счёт, что у /about; не посчитались — без цифр.
    getPlatformCounts().catch((e: unknown) => {
      console.error('[home] счёт платформы не получен', {
        code: (e as { code?: string })?.code, message: e instanceof Error ? e.message : String(e),
      });
      return null;
    }),
  ]);

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      {/* Шапка поверх фото героя: белые иконки до прокрутки (overPhoto). */}
      <Header overPhoto />
      <OnSiteBanner />
      <main className="flex-1 pb-16 md:pb-0">
        <DeskHero brief={brief} />

        <div className={`${HOME_CONTAINER} flex flex-col gap-24 pb-24 pt-20`}>
          <section className="grid grid-cols-1 items-start gap-10 lg:grid-cols-12 lg:gap-14" aria-label="Обстановка сегодня">
            <div className="lg:col-span-7">
              <DeskPlanChanges changes={brief.changes} feedCount={brief.svodka?.safety?.feedCount ?? null} trusted={brief.safetyTrusted} />
            </div>
            <div className="lg:col-span-5">
              <DeskVolcanoBoard volcanoes={brief.svodka?.volcanoes ?? null} />
            </div>
          </section>

          <SectionErrorBoundary>
            <DeskTours plates={plates} total={catalogSummary?.total ?? null} />
          </SectionErrorBoundary>

          <DeskHelp />

          {/* О платформе и дороги в остальные разделы (владелец 30.09). */}
          <DeskAbout counts={counts} />
        </div>
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
