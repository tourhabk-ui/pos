import type { Metadata } from 'next';
import Link from 'next/link';
import { Shield, MapPin, Users, Zap, ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { getPlatformCounts } from '@/lib/stats/platform-counts';
import { queryCatalogSummaryForPage } from '@/lib/search';
import { defaultOgImages } from '@/lib/seo/og-image';
import { REQUISITES } from '@/lib/legal/requisites';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

// Цифры страницы — из базы, а не из текста: прежние «779 / 294» стояли здесь
// с мая и расходились с главной (замер 30.09: 380 мест, 391 маршрут).
// Счёт кэшируется на час там же, где его берёт главная (unstable_cache), —
// поэтому страница рендерится на запросе. `revalidate = 3600` здесь не спасал:
// первая версия собиралась на сборке Docker без базы, и до первой
// перегенерации «О платформе» отдавала страницу без цифр (аудит 01.10, STALE).
// Сторож: tests/unit/no-build-time-db.test.ts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'О платформе Ведар — честный проводник по Камчатке',
  description:
    'Ведар — туристическая платформа Камчатки. Помогаем безопасно спланировать поездку: AI-помощник Кузьмич, проверенные операторы, офлайн-карта и SOS.',
  keywords: [
    'Ведар о нас',
    'туристическая платформа Камчатки',
    'безопасные туры Камчатка',
    'кто мы vedarai',
  ],
  alternates: { canonical: `${SITE}/about` },
  openGraph: {
    images: defaultOgImages(),
    title: 'О платформе Ведар',
    description: 'Честный проводник по Камчатке: AI, безопасность, проверенные операторы.',
    url: `${SITE}/about`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

const PILLARS = [
  {
    icon: Shield,
    title: 'Безопасность прежде всего',
    body: 'SOS-кнопка, офлайн-карта, профили безопасности точек, чек-лист снаряжения и прямая связь с МЧС — встроены в платформу, а не добавлены потом.',
  },
  {
    icon: MapPin,
    title: 'Маршруты и точки с рисками',
    body: 'Вулканы, горячие источники, гейзеры, озёра — каждая точка с координатами, описанием сезонности и реальными рисками. Данные из государственных источников и полевых наблюдений.',
  },
  {
    icon: Users,
    title: 'Только проверенные операторы',
    body: 'Туры на платформе ведут туроператоры Камчатки с отметкой проверки. Никаких анонимных предложений — только официально зарегистрированные компании.',
  },
  {
    icon: Zap,
    title: 'AI без маркетинга',
    body: 'Кузьмич — помощник, а не чат-бот продаж. Он ответит про погоду, опасности, снаряжение и МЧС честно, без приукрашивания. Работает в Telegram, MAX и прямо на сайте.',
  },
];

interface Stat { value: string; label: string }

/**
 * Живые цифры: места, маршруты и профили безопасности — тем же счётом, что
 * на главной (getPlatformCounts), туры — сводкой каталога. Не посчиталось —
 * цифры нет (§4.0), отказ в логе. Операторов и гидов не пишем: у этих чисел
 * нет счёта в коде, а «13 / 112» с мая стали бы новым «778 мест».
 */
async function loadStats(): Promise<Stat[]> {
  const [counts, catalog] = await Promise.all([
    getPlatformCounts().catch((e: unknown) => {
      console.error('[about] счёт платформы не получен', { message: e instanceof Error ? e.message : String(e) });
      return null;
    }),
    queryCatalogSummaryForPage().catch((e: unknown) => {
      console.error('[about] сводка каталога не получена', { message: e instanceof Error ? e.message : String(e) });
      return null;
    }),
  ]);
  const out: Stat[] = [];
  const fmt = (n: number) => n.toLocaleString('ru-RU');
  if (counts && counts.places > 0) out.push({ value: fmt(counts.places), label: 'мест на карте' });
  if (counts && counts.routes > 0) out.push({ value: fmt(counts.routes), label: 'маршрутов' });
  if (counts && counts.safetyProfiles > 0) out.push({ value: fmt(counts.safetyProfiles), label: 'профилей безопасности' });
  if (catalog && catalog.total > 0) out.push({ value: fmt(catalog.total), label: 'туров от операторов' });
  return out;
}

export default async function AboutPage() {
  const stats = await loadStats();
  return (
    <>
      <Header />
      <main className="bg-[var(--bg-primary)] min-h-screen">

        {/* Hero */}
        <section className="pt-24 pb-16 px-6">
          <div className="max-w-4xl mx-auto">
            <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-6 inline-block">
              О платформе
            </span>
            <h1 className="font-playfair text-4xl md:text-6xl font-bold leading-tight text-[var(--text-primary)] mb-6">
              Честный проводник<br />
              <span className="text-[var(--accent)] italic">по Камчатке</span>
            </h1>
            <p className="text-[var(--text-secondary)] text-lg md:text-xl font-light max-w-2xl leading-relaxed">
              Ведар — туристическая платформа Камчатки. Помогаем безопасно спланировать поездку:
              AI-помощник, офлайн-карта, проверенные операторы и быстрая связь с МЧС.
            </p>
          </div>
        </section>

        {/* Stats — только посчитанное; нет чисел — нет блока */}
        {stats.length > 0 && (
        <section className="py-10 px-6 border-y border-[var(--border)]">
          <div className="max-w-4xl mx-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              {stats.map((s) => (
                <div key={s.label} className="text-center">
                  <p className="font-playfair text-4xl font-bold text-[var(--accent)]">{s.value}</p>
                  <p className="text-sm text-[var(--text-muted)] mt-1">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
        )}

        {/* Mission */}
        <section className="py-16 px-6">
          <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-start">
            <div>
              <h2 className="font-playfair text-3xl font-bold text-[var(--text-primary)] mb-4">
                Почему мы существуем
              </h2>
              <p className="text-[var(--text-secondary)] leading-relaxed mb-4">
                Камчатка — одно из последних нетронутых мест планеты. Каждый год сюда приезжают тысячи
                туристов, и каждый год часть из них попадает в опасные ситуации из-за плохой подготовки,
                ненадёжных операторов или отсутствия информации в нужный момент.
              </p>
              <p className="text-[var(--text-secondary)] leading-relaxed mb-4">
                Мы создали платформу, где безопасность — не раздел FAQ, а основа архитектуры.
                SOS работает без интернета. Карта кэшируется заранее. Каждый маршрут содержит
                реальные данные о рисках, а не маркетинговые описания.
              </p>
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Наш принцип: сначала правда о месте — потом коммерческое предложение.
                Турист должен понять опасности до того, как нажмёт «отправить заявку».
              </p>
            </div>
            <div className="bg-[var(--bg-card)] rounded-lg p-6 border border-[var(--border)]">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">
                Реквизиты
              </p>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-[var(--text-muted)]">Компания</dt>
                  <dd className="text-[var(--text-primary)] font-medium">ООО «ПОС-СЕРВИС»</dd>
                </div>
                <div>
                  <dt className="text-[var(--text-muted)]">ИНН</dt>
                  <dd className="text-[var(--text-primary)] font-medium">4101147649</dd>
                </div>
                <div>
                  <dt className="text-[var(--text-muted)]">Адрес</dt>
                  <dd className="text-[var(--text-primary)] font-medium">
                    683024, Камчатский край,<br />г. Петропавловск-Камчатский
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--text-muted)]">Телефон</dt>
                  <dd className="text-[var(--text-primary)] font-medium">{REQUISITES.phone}</dd>
                </div>
                <div>
                  <dt className="text-[var(--text-muted)]">Email</dt>
                  <dd className="text-[var(--text-primary)] font-medium">pospk@mail.ru</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        {/* Pillars */}
        <section className="py-16 px-6 bg-[var(--bg-card)] border-y border-[var(--border)]">
          <div className="max-w-4xl mx-auto">
            <h2 className="font-playfair text-3xl font-bold text-[var(--text-primary)] mb-10">
              На чём стоит платформа
            </h2>
            <div className="grid md:grid-cols-2 gap-6">
              {PILLARS.map((p) => (
                <div key={p.title} className="flex gap-4">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--bg-hover)] flex items-center justify-center">
                    <p.icon className="w-5 h-5 text-[var(--accent)]" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-[var(--text-primary)] mb-1">{p.title}</h3>
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{p.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 px-6">
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row gap-4">
            <Link
              href="/routes"
              className="ds-btn ds-btn-primary inline-flex items-center gap-2"
            >
              Исследовать маршруты
              <ChevronRight className="w-4 h-4" />
            </Link>
            <Link
              href="/catalog"
              className="ds-btn ds-btn-secondary inline-flex items-center gap-2"
            >
              Туры от операторов
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

      </main>
      <Footer />
    </>
  );
}
