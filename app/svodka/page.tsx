import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Mountain, CloudSnow, Phone } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { SvodkaCopy } from '@/components/svodka/SvodkaCopy';
import { loadSvodka, svodkaText, volcanoPhrase, weatherPhrase, type VolcanoLine } from '@/lib/svodka/svodka';
import { defaultOgImages } from '@/lib/seo/og-image';

/**
 * Сводка дня для гидов и операторов. Шапка и источники — lib/svodka/svodka.ts.
 *
 * Рендер на каждый запрос, как у главной. Первая редакция (#2117) ставила
 * `revalidate = 600` — и страница пререндерилась при СБОРКЕ, где базы нет:
 * замер 30.09 (prod-check run 74) — первый посетитель после деплоя получил
 * «обстановку получить не удалось» и «прогноз не получили» у трёх мест из
 * четырёх, хотя всё было доступно. Для страницы безопасности копия со сборки
 * хуже, чем её отсутствие. Open-Meteo при этом не дёргается на каждый заход:
 * у fetchForecastDays свой кэш на 3 часа.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Сводка для гидов Камчатки — обстановка, вулканы, погода',
  description:
    'Утренняя сводка для гидов и туроператоров Камчатки: предупреждения МЧС и закрытые дороги, вулканы по KVERT и КФ ЕГС, погода у Авачинского, Мутновского и в Эссо.',
  alternates: { canonical: 'https://vedarai.ru/svodka' },
  openGraph: {
    images: defaultOgImages(),
    title: 'Сводка для гидов Камчатки',
    description: 'Что меняет планы сегодня: МЧС, вулканы, погода. С источником у каждой строки.',
    url: 'https://vedarai.ru/svodka',
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'website',
  },
};

const LEVEL_COLOR: Record<VolcanoLine['level'], string> = {
  red: 'var(--danger)',
  orange: 'var(--accent)',
  yellow: 'var(--warning)',
};

function kamchatkaTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka' });
}

export default async function SvodkaPage() {
  const s = await loadSvodka();
  const text = svodkaText(s);
  const alerts = s.safety?.feedTitles ?? null;
  const assembled = kamchatkaTime(s.generatedAt);

  return (
    <>
      <Header />
      <main className="ds-page pt-20 pb-24">
        <div className="max-w-3xl mx-auto flex flex-col gap-8">
          <header className="flex flex-col gap-3">
            <p className="ds-label">Для гидов и операторов · {s.dateLabel}</p>
            <h1 className="ds-h1" style={{ fontFamily: 'var(--font-playfair)' }}>Сводка дня</h1>
            <p className="text-[var(--text-secondary)] max-w-xl">
              Что сегодня меняет планы на Камчатке. У каждой строки — источник. Где источник не ответил, так и написано.
            </p>
            {assembled && <p className="text-sm text-[var(--text-secondary)]">Собрано {assembled} по Камчатке</p>}
          </header>

          <section className="ds-section flex flex-col gap-3" aria-labelledby="svodka-alerts">
            <h2 id="svodka-alerts" className="ds-h2 flex items-center gap-2">
              <AlertTriangle size={20} aria-hidden className="text-[var(--warning)]" />
              Что меняет планы
            </h2>
            {!s.safety ? (
              <p className="text-[var(--text-secondary)]">Обстановку получить не удалось. Это не «всё спокойно» — проверьте МЧС напрямую.</p>
            ) : alerts === null ? (
              <p className="text-[var(--text-secondary)]">Список предупреждений получить не удалось.</p>
            ) : alerts.length === 0 ? (
              <p>Предупреждений, меняющих планы, нет.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {alerts.map((t, i) => {
                  const basis = s.safety?.feedBasis?.[i] ?? null;
                  return (
                    <li key={t} className="border-l-2 border-[var(--warning)] pl-3">
                      {t}
                      {basis && (
                        <span className="block text-sm text-[var(--text-secondary)]">
                          Основание:{' '}
                          {basis.url
                            ? <a href={basis.url} target="_blank" rel="noopener noreferrer" className="underline">{basis.title}</a>
                            : basis.title}
                          {basis.recognized ? ' — распознано со снимка, номер сверяйте по ссылке' : ''}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {s.safety && (
              <p className="text-sm text-[var(--text-secondary)]">
                Источник главного предупреждения: {s.safety.source}
                {s.safety.feedCount !== null && s.safety.activeCount > s.safety.feedCount
                  ? ` · всего активных в крае ${s.safety.activeCount}, здесь только меняющие планы`
                  : ''}
              </p>
            )}
          </section>

          <section className="ds-section flex flex-col gap-3" aria-labelledby="svodka-volcanoes">
            <h2 id="svodka-volcanoes" className="ds-h2 flex items-center gap-2">
              <Mountain size={20} aria-hidden className="text-[var(--accent)]" />
              Вулканы выше фона
            </h2>
            {!s.volcanoes ? (
              <p className="text-[var(--text-secondary)]">Сводки вулканов получить не удалось.</p>
            ) : s.volcanoes.items.length === 0 ? (
              <p>{s.volcanoes.complete ? 'Повышенной активности нет.' : 'По доступным данным повышенных нет, но не все источники проверены.'}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {s.volcanoes.items.map((v) => (
                  <li key={v.name} className="flex items-start gap-3">
                    <span aria-hidden className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: LEVEL_COLOR[v.level] }} />
                    <span>{volcanoPhrase(v)}</span>
                  </li>
                ))}
                {s.volcanoes.more > 0 && <li className="text-[var(--text-secondary)]">и ещё {s.volcanoes.more}</li>}
              </ul>
            )}
            {s.volcanoes && <p className="text-sm text-[var(--text-secondary)]">{s.volcanoes.sources} Код — об активности вулкана, а не разрешение на выход.</p>}
          </section>

          <section className="ds-section flex flex-col gap-3" aria-labelledby="svodka-weather">
            <h2 id="svodka-weather" className="ds-h2 flex items-center gap-2">
              <CloudSnow size={20} aria-hidden className="text-[var(--ocean)]" />
              Погода
            </h2>
            <ul className="flex flex-col gap-3">
              {s.weather.map((w) => (
                <li key={w.name} className="flex flex-col gap-1">
                  <span className="font-semibold">{w.name}</span>
                  {w.days && w.days.length > 0 ? (
                    w.days.map((d) => (
                      <span key={d.date} className="text-[var(--text-secondary)] tabular-nums">
                        {d.date.slice(8, 10)}.{d.date.slice(5, 7)} — {weatherPhrase(d)}
                      </span>
                    ))
                  ) : (
                    <span className="text-[var(--text-secondary)]">Прогноз не получили{w.reason ? ` (${w.reason})` : ''}.</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-sm text-[var(--text-secondary)]">Прогноз Open-Meteo по координатам места. В горах погода меняется быстрее прогноза.</p>
            <Link href="/weather" className="text-sm font-semibold text-[var(--ocean)]">Прогноз на 7 дней по местам →</Link>
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="svodka-share">
            <h2 id="svodka-share" className="ds-h2">Переслать группе или коллегам</h2>
            <SvodkaCopy text={text} />
            <pre className="ds-card whitespace-pre-wrap text-sm leading-relaxed" style={{ padding: 16, fontFamily: 'var(--font-outfit)' }}>{text}</pre>
          </section>

          <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Phone size={16} aria-hidden />
            Экстренный телефон 112. В беде на маршруте — кнопка SOS в шапке.
          </p>
        </div>
      </main>
      <BottomNav activePath="/svodka" />
    </>
  );
}
