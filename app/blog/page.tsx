import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, Rss } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const metadata: Metadata = {
  title: 'Блог Ведара — Камчатка: маршруты, безопасность, операторы',
  description:
    'Актуальные материалы о путешествиях по Камчатке: обновления маршрутов, разведданные о сезоне, новости платформы и советы по безопасности.',
  keywords: [
    'блог камчатка',
    'путешествия камчатка',
    'маршруты камчатка новости',
    'туризм камчатка 2026',
  ],
  alternates: { canonical: `${SITE}/blog` },
  openGraph: {
    title: 'Блог Ведара — Камчатка',
    description: 'Актуальные материалы о путешествиях и безопасности на Камчатке.',
    url: `${SITE}/blog`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

interface DigestEntry {
  slug: string;
  title: string;
  compiled_truth: string;
  created_at: string;
}

async function getLatestDigests(): Promise<DigestEntry[]> {
  try {
    const { rows } = await pool.query<DigestEntry>(`
      SELECT slug, title, compiled_truth, created_at::text
      FROM agent_knowledge
      WHERE type IN ('digest', 'decision')
        AND (slug LIKE 'digest/%' OR slug LIKE 'proposals/%')
      ORDER BY created_at DESC
      LIMIT 9
    `);
    return rows;
  } catch {
    return [];
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export const STATIC_ARTICLES = [
  {
    slug: 'kamchatka-season-2026',
    title: 'Сезон 2026 на Камчатке: что изменилось',
    excerpt:
      'Открытие маршрутов, новые ограничения Кроноцкого заповедника, погодные аномалии июня и рекомендации по подготовке к летнему сезону.',
    tag: 'Сезон',
    date: '2026-06-01',
    content: `Камчатский сезон 2026 начался с нескольких важных изменений, о которых стоит знать заранее.

**Кроноцкий заповедник**

С 1 июня введены новые квоты на посещение Долины гейзеров: не более 48 человек в день. Бронирование — только через официальный сайт заповедника. Самостоятельный заезд без группы с лицензированным гидом запрещён.

**Открытие маршрутов**

К середине июня открыты для посещения:
— Авачинский вулкан (тропа до кратера)
— Мутновский вулкан (стандартный маршрут)
— Налычево (все треки)
— Горелый вулкан (маршрут до кальдеры)

Ключевская сопка и Шивелуч остаются закрытыми из-за высокой вулканической активности.

**Погодные аномалии**

Июнь 2026 — один из самых тёплых за последние 10 лет. Снег сошёл на 2–3 недели раньше обычного. Это открывает маршруты раньше, но повышает риск камнепадов на тропах с крутыми склонами.

**Что взять с собой**

Солнцезащитный крем SPF 50+ обязателен — на высоте ультрафиолет значительно интенсивнее. Тёплый слой всё равно нужен: вечером температура падает до +5°C даже в июле.`,
  },
  {
    slug: 'sos-offline-guide',
    title: 'Как работает SOS-кнопка без интернета',
    excerpt:
      'Подробный разбор: как Ведар сохраняет координаты GPS, отправляет сигнал тревоги и передаёт маршрут экстренным службам даже без сети.',
    tag: 'Безопасность',
    date: '2026-05-20',
    content: `На Камчатке покрытие мобильной сети заканчивается примерно в 30 км от Петропавловска. Большинство популярных маршрутов проходит вне зоны 4G. Именно поэтому SOS-функция Ведара работает без интернета.

**Как это устроено**

1. **GPS работает без сети.** Ваш телефон получает координаты со спутника — для этого не нужен интернет, только включённый GPS.

2. **Координаты сохраняются локально.** При нажатии SOS платформа записывает вашу точку в браузерную базу данных (IndexedDB). Данные хранятся на устройстве.

3. **Отправка при появлении сети.** Как только телефон поймает хоть какой-то сигнал, данные автоматически отправятся в МЧС Камчатки через фоновую синхронизацию (Background Sync API).

4. **Экстренный номер работает всегда.** 112 работает через любую сотовую сеть — без интернета, без баланса и даже без SIM-карты, и сам переключает на МЧС/полицию/скорую.

**Что делать при ЧС**

— Нажмите SOS в приложении (сохранит координаты)
— Позвоните 112 (работает без интернета)
— Активируйте спутниковый мессенджер если есть (Garmin inReach, SPOT)
— Оставайтесь на месте — спасателям нужны координаты, а не ваше движение

**Важно перед выходом**

Скачайте маршрут офлайн через кнопку "Скачать" на странице маршрута. Это создаст локальную копию треков и безопасных точек.`,
  },
  {
    slug: 'operators-2026',
    title: 'Верифицированные операторы Камчатки 2026',
    excerpt:
      'Критерии проверки, как отличить надёжного оператора от однодневки и почему Ведар не добавляет анонимные предложения в каталог.',
    tag: 'Операторы',
    date: '2026-05-10',
    content: `На Камчатке несколько десятков туроператоров, но качество сервиса и уровень безопасности у них разный. Ведар добавляет в каталог только верифицированных операторов.

**Критерии верификации**

— Регистрация в реестре туроператоров Ростуризма (ИНН + номер реестра)
— Наличие полиса страхования ответственности
— Гиды с аттестацией МЧС или альпинистскими разрядами (для горных маршрутов)
— Минимум 2 сезона работы на Камчатке
— Отсутствие жалоб от туристов за последний год

**Как отличить надёжного оператора**

Хороший оператор всегда:
— регистрирует группу в МЧС перед выходом
— выдаёт спутниковый коммуникатор (или требует наличие у группы)
— согласовывает посещение природных парков заранее
— проводит инструктаж по безопасности до маршрута

Если оператор не делает хотя бы первый пункт — это серьёзный сигнал.

**Анонимных предложений нет**

Ведар не показывает туры без привязки к конкретному юрлицу или ИП. Если вы видите тур без информации об операторе — это не Ведар.

Все операторы каталога проходят повторную верификацию каждый сезон.`,
  },
];

export default async function BlogPage() {
  const digests = await getLatestDigests();

  return (
    <>
      <Header />
      <main className="bg-[var(--bg-primary)] min-h-screen">

        {/* Hero */}
        <section className="pt-24 pb-12 px-6">
          <div className="max-w-4xl mx-auto">
            <span className="text-[var(--accent)] font-bold tracking-[0.4em] uppercase text-[10px] mb-6 inline-block">
              Блог
            </span>
            <h1 className="font-playfair text-4xl md:text-5xl font-bold leading-tight text-[var(--text-primary)] mb-4">
              Камчатка: маршруты,<br />
              <span className="text-[var(--accent)] italic">безопасность, сезон</span>
            </h1>
            <p className="text-[var(--text-secondary)] text-lg font-light max-w-2xl">
              Разборы маршрутов, обновления сезона, новости платформы и сигналы от агентов разведки.
            </p>
          </div>
        </section>

        {/* Static articles */}
        <section className="px-6 pb-12">
          <div className="max-w-4xl mx-auto">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-6">
              Материалы редакции
            </p>
            <div className="grid md:grid-cols-3 gap-6">
              {STATIC_ARTICLES.map((a) => (
                <Link
                  key={a.slug}
                  href={`/blog/${a.slug}`}
                  className="ds-card flex flex-col gap-3 p-5 hover:border-[var(--accent)] transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent)] bg-[var(--bg-hover)] px-2 py-0.5 rounded">
                      {a.tag}
                    </span>
                    <time className="text-xs text-[var(--text-muted)]">
                      {formatDate(a.date)}
                    </time>
                  </div>
                  <h2 className="font-semibold text-[var(--text-primary)] leading-snug">
                    {a.title}
                  </h2>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed flex-1">
                    {a.excerpt}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Scout digests */}
        {digests.length > 0 && (
          <section className="px-6 pb-16 border-t border-[var(--border)] pt-12">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center gap-2 mb-6">
                <Rss className="w-4 h-4 text-[var(--accent)]" />
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                  Разведдайджест — автоматический синтез
                </p>
              </div>
              <div className="space-y-4">
                {digests.map((d) => (
                  <div
                    key={d.slug}
                    className="ds-card p-5 flex flex-col gap-2"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-semibold text-[var(--text-primary)] text-sm leading-snug">
                        {d.title}
                      </h3>
                      <time className="text-xs text-[var(--text-muted)] shrink-0">
                        {formatDate(d.created_at)}
                      </time>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3">
                      {stripHtml(d.compiled_truth).slice(0, 280)}
                      {d.compiled_truth.length > 280 ? '…' : ''}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* CTA */}
        <section className="py-12 px-6 border-t border-[var(--border)]">
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row gap-4">
            <Link
              href="/routes"
              className="ds-btn ds-btn-primary inline-flex items-center gap-2"
            >
              Смотреть маршруты
              <ChevronRight className="w-4 h-4" />
            </Link>
            <Link
              href="/hub/safety"
              className="ds-btn ds-btn-secondary inline-flex items-center gap-2"
            >
              Безопасность
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

      </main>
      <Footer />
    </>
  );
}
