import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ClipboardCheck, TreePine, Mountain, Radio, ShieldAlert, CloudRain, Phone, Backpack, WifiOff,
} from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { FAQJsonLd } from '@/components/seo/JsonLd';
import {
  MCHS_SOURCE, MCHS_CHANNELS, MCHS_REQUIRED_DATA, MCHS_DEADLINE_SHORT, MCHS_LEAD_WORKING_DAYS,
} from '@/lib/safety/mchs-registration';
import { PARK_PERMIT_SOURCE, PARK_PERMIT_CHANNELS, FREE_VISIT_AREAS } from '@/lib/safety/park-permit';
import { DIFFICULTY_SCALE } from '@/lib/routes/difficulty-scale';
import { DIFFICULTY_WORDS } from '@/lib/tours/describe';
import { alertGuidance } from '@/lib/safety/alert-guidance';
import { EMERGENCY_NUMBERS, EMERGENCY_PRIMARY, telHref } from '@/lib/safety/emergency-numbers';
import { defaultOgImages } from '@/lib/seo/og-image';

/**
 * «Как подготовиться к поездке на Камчатку» — общая памятка (решение владельца
 * 30.09 после разбора сайта «Край Вулканов»: у них такая страница есть, у нас
 * не было).
 *
 * Правило страницы: ни одного факта своими словами. Сроки МЧС, каналы подачи,
 * разрешения парка, шкала сложности, медвежий протокол, реки и погода, номера —
 * импортом из тех же справочников, что кормят карточки маршрутов, пуши и SOS
 * (§4.0, §8: критичные факты — из данных). Поменялся справочник — поменялась
 * страница. Чего в справочниках нет (климат по месяцам, общий список
 * снаряжения), того нет и здесь: снаряжение зависит от маршрута и лежит на его
 * странице.
 */

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';
const TITLE = 'Как подготовиться к поездке на Камчатку';
const DESCRIPTION =
  `Регистрация группы в МЧС за ${MCHS_LEAD_WORKING_DAYS} рабочих дней, разрешение природного парка, ` +
  'сложность маршрута, медведи, реки и непогода, экстренные номера — памятка перед походом.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE}/prepare` },
  openGraph: {
    images: defaultOgImages(),
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE}/prepare`,
    siteName: 'Ведар',
    locale: 'ru_RU',
    type: 'article',
  },
};

const LEVEL_TITLE: Record<string, string> = {
  easy: 'Лёгкий',
  medium: 'Средний',
  hard: 'Сложный',
  extreme: 'Экстремальный',
};

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="ds-card px-5 py-5 md:px-6">
      <div className="flex items-start gap-3">
        <span className="mt-1 text-[var(--accent)] flex-shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-playfair font-bold text-xl text-[var(--text-primary)] leading-snug">{title}</h2>
          <div className="mt-3 text-sm text-[var(--text-secondary)] leading-relaxed space-y-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function Steps({ items }: { items: readonly string[] }) {
  return (
    <ol className="list-decimal pl-5 space-y-1.5">
      {items.map((s) => <li key={s}>{s}</li>)}
    </ol>
  );
}

export default function PreparePage() {
  const bear = alertGuidance('bear');
  const flood = alertGuidance('flood');
  const weather = alertGuidance('weather');
  const levels = [
    // Каскад computeDifficulty: первый уровень, в ОБА строгих порога которого
    // маршрут укладывается; не уложился ни в один — экстремальный.
    ...DIFFICULTY_SCALE.map((d) => ({
      level: d.level,
      bound: `набор меньше ${d.maxGainM} м и дистанция меньше ${d.maxKm} км`,
    })),
    {
      level: 'extreme',
      bound: `не укладывается в пороги выше`,
    },
  ];

  const faq = [
    {
      question: 'За сколько дней регистрировать группу в МЧС на Камчатке?',
      answer: `${MCHS_DEADLINE_SHORT}. Способы подачи: ${MCHS_CHANNELS.map((c) => c.title.toLowerCase()).join(', ')}. Источник: ${MCHS_SOURCE.authority}.`,
    },
    {
      question: 'Нужно ли разрешение на посещение природного парка?',
      answer: `Для посещения природного парка нужно разрешение парка; регистрация в МЧС его не заменяет. Оформить: ${PARK_PERMIT_CHANNELS.map((c) => c.title).join(', ')}. Источник: ${PARK_PERMIT_SOURCE.authority}.`,
    },
    {
      question: 'Что делать при встрече с медведем?',
      answer: bear.steps.join(' '),
    },
    {
      question: 'Какой номер вызова экстренных служб на Камчатке?',
      answer: `${EMERGENCY_PRIMARY.phone} — ${EMERGENCY_PRIMARY.name}. ${EMERGENCY_PRIMARY.hint ?? ''}`.trim(),
    },
  ];

  return (
    <div className="ds-page min-h-screen">
      <Header />
      <FAQJsonLd questions={faq} />
      <main className="pb-16">
        <section className="max-w-3xl mx-auto px-4 pt-12 pb-8">
          <p className="ds-label">Перед поездкой</p>
          <h1 className="font-playfair font-bold text-4xl md:text-5xl text-[var(--text-primary)] leading-tight mt-2">
            {TITLE}
          </h1>
          <p className="mt-4 text-base text-[var(--text-secondary)] leading-relaxed">
            Здесь собрано то, что нужно сделать до выхода на маршрут. Сроки, адреса и номера взяты у
            ведомств и обновляются вместе с платформой — источник указан в каждом разделе.
          </p>
        </section>

        <div className="max-w-3xl mx-auto px-4 space-y-4">
          <Card icon={<ClipboardCheck className="w-5 h-5" />} title="Зарегистрируйте группу в МЧС">
            <p className="font-semibold text-[var(--text-primary)]">{MCHS_DEADLINE_SHORT}.</p>
            <p>Способы подачи:</p>
            <ul className="space-y-1.5">
              {MCHS_CHANNELS.map((c) => (
                <li key={c.key}>
                  <span className="font-semibold text-[var(--text-primary)]">{c.title}.</span>{' '}
                  {c.href ? <a href={c.href} className="text-[var(--ocean)] hover:underline" rel="noopener noreferrer" target="_blank">{c.detail}</a> : c.detail}
                </li>
              ))}
            </ul>
            <p>Что указать в заявке:</p>
            <Steps items={MCHS_REQUIRED_DATA} />
            <p className="text-xs text-[var(--text-muted)]">Источник: {MCHS_SOURCE.authority}, {MCHS_SOURCE.asOf}.</p>
          </Card>

          <Card icon={<TreePine className="w-5 h-5" />} title="Оформите разрешение природного парка">
            <p>
              Находиться на территории природного парка можно только с разрешением парка. Это
              отдельная обязанность: регистрация в МЧС её не заменяет, и наоборот.
              {FREE_VISIT_AREAS.length > 0 && <> Без разрешения можно посетить: {FREE_VISIT_AREAS.join(', ')}.</>}
            </p>
            <ul className="space-y-1.5">
              {PARK_PERMIT_CHANNELS.map((c) => (
                <li key={c.key}>
                  <span className="font-semibold text-[var(--text-primary)]">{c.title}.</span>{' '}
                  {c.href ? <a href={c.href} className="text-[var(--ocean)] hover:underline" rel="noopener noreferrer" target="_blank">{c.detail}</a> : c.detail}
                </li>
              ))}
            </ul>
            <p className="text-xs text-[var(--text-muted)]">
              Источник: <a href={PARK_PERMIT_SOURCE.url} className="hover:underline" rel="noopener noreferrer" target="_blank">{PARK_PERMIT_SOURCE.authority}</a>, {PARK_PERMIT_SOURCE.asOf}.
            </p>
          </Card>

          <Card icon={<Mountain className="w-5 h-5" />} title="Оцените сложность маршрута">
            <p>Если оператор не указал сложность, Ведар считает её по набору высоты и дистанции — одинаково для всех маршрутов:</p>
            <ul className="space-y-2">
              {levels.map((l) => (
                <li key={l.level}>
                  <span className="font-semibold text-[var(--text-primary)]">{LEVEL_TITLE[l.level]}</span>
                  {' '}({l.bound}). {DIFFICULTY_WORDS[l.level]}.
                </li>
              ))}
            </ul>
            <p>
              Сложность, опасности и снаряжение конкретного маршрута — на его странице:{' '}
              <Link href="/routes" className="text-[var(--ocean)] hover:underline">маршруты Камчатки</Link>.
            </p>
          </Card>

          <Card icon={<Backpack className="w-5 h-5" />} title="Соберите снаряжение под маршрут">
            <p>
              Общего списка на все случаи нет и быть не может: восхождение на вулкан, сплав и
              рыбалка требуют разного. Снаряжение указано на странице каждого маршрута, а у туров —
              в разделе «Что взять с собой», который заполняет оператор.
            </p>
            <p>
              <Link href="/routes" className="text-[var(--ocean)] hover:underline">Маршруты</Link>
              {' · '}
              <Link href="/catalog" className="text-[var(--ocean)] hover:underline">Туры операторов</Link>
            </p>
          </Card>

          <Card icon={<Radio className="w-5 h-5" />} title="Продумайте связь">
            <p>
              На большинстве маршрутов сотовой связи нет. Как передать координаты без сети —
              спутниковые маяки, коммуникаторы, рации — разобрано отдельно:{' '}
              <Link href="/safety/communication" className="text-[var(--ocean)] hover:underline">связь и навигация на маршрутах</Link>.
            </p>
          </Card>

          <Card icon={<ShieldAlert className="w-5 h-5" />} title="Медведи">
            <Steps items={bear.steps} />
          </Card>

          <Card icon={<CloudRain className="w-5 h-5" />} title="Реки и непогода">
            {flood.known && (<><p className="font-semibold text-[var(--text-primary)]">Паводок и броды</p><Steps items={flood.steps} /></>)}
            {weather.known && (<><p className="font-semibold text-[var(--text-primary)]">Штормовая погода</p><Steps items={weather.steps} /></>)}
            <p>
              Текущие тревоги МЧС и состояние вулканов —{' '}
              <Link href="/safety" className="text-[var(--ocean)] hover:underline">обстановка в крае</Link>.
            </p>
          </Card>

          <Card icon={<WifiOff className="w-5 h-5" />} title="Скачайте всё, что нужно без сети">
            <p>
              Карту района и маршрут сохраните заранее — в поле сети не будет. Инструкции на случай
              медведя, извержения, гипотермии и потери ориентации работают офлайн:{' '}
              <Link href="/safety/offline" className="text-[var(--ocean)] hover:underline">офлайн-инструкции</Link>,{' '}
              <Link href="/map" className="text-[var(--ocean)] hover:underline">карта</Link>.
            </p>
          </Card>

          <Card icon={<Phone className="w-5 h-5" />} title="Запишите экстренные номера">
            <ul className="space-y-1.5">
              {EMERGENCY_NUMBERS.map((n) => (
                <li key={n.phone}>
                  <a href={telHref(n.phone)} className="font-semibold text-[var(--text-primary)] hover:underline">{n.phone}</a>
                  {' — '}{n.name}{n.hint ? `. ${n.hint}` : ''}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <section className="max-w-3xl mx-auto px-4 mt-10">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed border-t border-[var(--border)] pt-5">
            Памятка не заменяет инструктаж гида и регистрацию в МЧС. Если сведения ведомства
            расходятся с этой страницей, верно ведомство — напишите нам, и мы обновим справочник.
          </p>
        </section>
      </main>
    </div>
  );
}
