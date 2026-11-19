/**
 * Страницы «Сколько стоит поездка на Камчатку» и «Когда ехать на Камчатку»
 * (разбор видимости в ответах ИИ, 19.11). Числа — из базы (lib/seo/trip-cost);
 * у каждого блока три исхода: есть, пусто, «не загрузилось».
 */
import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import {
  RU_MONTHS_NOM, charterCostWords, costByKind, costFaq, stayCostWords, toursByMonth, whenFaq,
  type TripFaq,
} from '@/lib/seo/trip-cost';
import type { TripCostData } from '@/lib/seo/trip-cost-data';
import { plural } from '@/lib/home/data-freshness';

const NOT_LOADED = 'Не загрузилось: база не ответила. Попробуйте обновить страницу позже.';

function faqLd(faq: readonly TripFaq[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: 'ru',
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

function Faq({ faq }: { faq: readonly TripFaq[] }) {
  return (
    <section className="space-y-3" aria-labelledby="trip-faq">
      <h2 id="trip-faq" className="ds-h2">Частые вопросы</h2>
      <dl className="space-y-3">
        {faq.map((f) => (
          <div key={f.q} className="ds-card p-4 text-sm">
            <dt className="font-semibold" style={{ color: 'var(--text-primary)' }}>{f.q}</dt>
            <dd style={{ color: 'var(--text-secondary)' }}>{f.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{children}</p>;
}

export function TripCostView({ data }: { data: TripCostData }) {
  const kinds = data.tours ? costByKind(data.tours) : null;
  const stay = data.stays ? stayCostWords(data.stays) : null;
  const charter = data.carriers ? charterCostWords(data.carriers) : null;
  const faq = costFaq(kinds, stay, charter);
  const lead = data.tours && data.tours.length
    ? `На Ведаре сейчас ${data.tours.length} ${plural(data.tours.length, 'тур', 'тура', 'туров')} местных операторов. Ниже — их цены по видам, цены жилья за ночь и машины под заказ: всё из базы на сегодня, с единицей цены.`
    : null;
  return (
    <main className="ds-page" data-trip-page="cost">
      <JsonLd data={faqLd(faq)} />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <header className="space-y-3">
          <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>Сколько стоит поездка на Камчатку</h1>
          {lead && <p className="text-base" style={{ color: 'var(--text-primary)' }} data-trip-lead>{lead}</p>}
          <Muted>Общей суммы «за неделю» здесь нет: она зависит от того, что вы выберете. Смету из выбранных туров и жилья по их ценам складывает <Link className="underline" style={{ color: 'var(--ocean)' }} href="/planning">планер Ведара</Link>.</Muted>
        </header>

        <section className="space-y-3" aria-labelledby="cost-tours">
          <h2 id="cost-tours" className="ds-h2">Туры по видам</h2>
          {kinds === null ? <Muted>{NOT_LOADED}</Muted> : kinds.length === 0 ? <Muted>Опубликованных туров сейчас нет.</Muted> : (
            <ul className="space-y-2">
              {kinds.map((k) => (
                <li key={k.label} className="ds-card p-4 text-sm">
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{k.label}</span>
                  <span style={{ color: 'var(--text-secondary)' }}> · {k.count} {plural(k.count, 'тур', 'тура', 'туров')} · {k.prices ?? 'цена с понятной единицей не записана'}</span>
                </li>
              ))}
            </ul>
          )}
          <Muted>Цены — те, что операторы указали на Ведаре; итог называет оператор при подтверждении заявки. Все туры — в <Link className="underline" style={{ color: 'var(--ocean)' }} href="/catalog">каталоге</Link>.</Muted>
        </section>

        <section className="space-y-2" aria-labelledby="cost-stay">
          <h2 id="cost-stay" className="ds-h2">Жильё</h2>
          <Muted>{data.stays === null ? NOT_LOADED : stay ?? 'Цен жилья на Ведаре сейчас нет.'}</Muted>
          <Muted><Link className="underline" style={{ color: 'var(--ocean)' }} href="/accommodations">Жильё на Ведаре</Link></Muted>
        </section>

        <section className="space-y-2" aria-labelledby="cost-charter">
          <h2 id="cost-charter" className="ds-h2">Трансфер и машина под заказ</h2>
          <Muted>{data.carriers === null ? NOT_LOADED : charter ?? 'Прайсов перевозчиков на Ведаре сейчас нет.'}</Muted>
          <Muted><Link className="underline" style={{ color: 'var(--ocean)' }} href="/transfers">Перевозчики и прайсы</Link></Muted>
        </section>

        <section className="space-y-2" aria-labelledby="cost-flight">
          <h2 id="cost-flight" className="ds-h2">Перелёт</h2>
          <Muted>Цен на билеты у Ведара нет: их называют авиакомпании и сервисы продажи билетов. Задержки и отмены рейсов аэропорта Елизово — на <Link className="underline" style={{ color: 'var(--ocean)' }} href="/flights">табло аэропорта</Link>.</Muted>
        </section>

        <Faq faq={faq} />
        <Muted>Когда какие туры идут — на странице <Link className="underline" style={{ color: 'var(--ocean)' }} href="/kogda-ehat-na-kamchatku">«Когда ехать на Камчатку»</Link>.</Muted>
      </div>
    </main>
  );
}

export function WhenToGoView({ tours, fish }: { tours: TripCostData['tours']; fish: ReadonlyMap<number, string[]> }) {
  const byMonth = tours ? toursByMonth(tours) : null;
  const faq = whenFaq(byMonth?.months ?? null, fish);
  return (
    <main className="ds-page" data-trip-page="when">
      <JsonLd data={faqLd(faq)} />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <header className="space-y-3">
          <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>Когда ехать на Камчатку</h1>
          <Muted>По месяцам: сколько туров на Ведаре идёт в этот месяц по данным операторов, какие виды и какая рыба в сезоне по справочнику рыб Камчатки. Погоду на ближайшие дни показывает <Link className="underline" style={{ color: 'var(--ocean)' }} href="/weather">прогноз</Link>.</Muted>
        </header>

        <section className="space-y-3" aria-labelledby="when-months">
          <h2 id="when-months" className="ds-h2">По месяцам</h2>
          {byMonth === null ? <Muted>{NOT_LOADED}</Muted> : (
            <ol className="space-y-2">
              {byMonth.months.map((m) => {
                const f = fish.get(m.month) ?? [];
                return (
                  <li key={m.month} className="ds-card p-4 text-sm" data-month={m.month}>
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{RU_MONTHS_NOM[m.month - 1]}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {' · '}{m.count > 0 ? `${m.count} ${plural(m.count, 'тур', 'тура', 'туров')}: ${m.kinds.join(', ').toLowerCase()}` : 'туров нет'}
                      {f.length > 0 && ` · рыба в сезоне: ${f.join(', ').toLowerCase()}`}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {byMonth && byMonth.unknown > 0 && <Muted>У {byMonth.unknown} {plural(byMonth.unknown, 'тура', 'туров', 'туров')} сезон не записан — они здесь не посчитаны.</Muted>}
          <Muted>Сезоны рыб — из <Link className="underline" style={{ color: 'var(--ocean)' }} href="/fish">справочника рыб Камчатки</Link>; туры — в <Link className="underline" style={{ color: 'var(--ocean)' }} href="/catalog">каталоге</Link>.</Muted>
        </section>

        <Faq faq={faq} />
        <Muted>Цены туров, жилья и машин — на странице <Link className="underline" style={{ color: 'var(--ocean)' }} href="/skolko-stoit-poezdka-na-kamchatku">«Сколько стоит поездка на Камчатку»</Link>.</Muted>
      </div>
    </main>
  );
}
