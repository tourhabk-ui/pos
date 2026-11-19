/**
 * Две страницы-ответа: «Сколько стоит поездка на Камчатку» и «Когда ехать на
 * Камчатку» (lib/seo/trip-guides). Серверные компоненты: данные приходят
 * готовыми. Вопросы на экране и в разметке FAQPage — один массив.
 */
import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import type { LandingFaq } from '@/lib/seo/query-landings';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import {
  COST_ORDER_NOTE, FLIGHT_PRICE_WORDS, TOTAL_PRICE_WORDS, TRANSFER_PRICE_WORDS, TRIP_COST, TRIP_GUIDES, TRIP_SEASON,
  costByActivity, costByTopic, costFaq, costLead, seasonFaq, seasonLead, seasonTable, spanWords, stayPriceWords, topicLandings,
  toursWord, type StayPrices, type TripGuide,
} from '@/lib/seo/trip-guides';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

const UNAVAILABLE = 'Туры не загрузились: база не ответила. Попробуйте позже или откройте каталог.';
const EMPTY = 'Сейчас на Ведаре нет опубликованных туров.';

export function guideJsonLd(g: TripGuide, faq: readonly LandingFaq[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': 'FAQPage',
      inLanguage: 'ru',
      url: `${SITE}${g.path}`,
      mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    }],
  };
}

const linkStyle = { color: 'var(--ocean)' } as const;

function Faq({ faq }: { faq: readonly LandingFaq[] }) {
  return (
    <section className="space-y-3" aria-labelledby="guide-faq">
      <h2 id="guide-faq" className="ds-h2">Частые вопросы</h2>
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

function GuideFooter({ self }: { self: TripGuide }) {
  return (
    <footer className="text-sm space-y-2" style={{ color: 'var(--text-secondary)' }} data-guide-more>
      <p>Ещё по теме:</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {TRIP_GUIDES.filter((g) => g.key !== self.key).map((g) => (
          <li key={g.path}><Link className="underline" href={g.path}>{g.h1}</Link></li>
        ))}
        {topicLandings().map((l) => (
          <li key={l.path}><Link className="underline" href={l.path}>{l.h1}</Link></li>
        ))}
        <li><Link className="underline" href="/catalog">Каталог туров</Link></li>
      </ul>
    </footer>
  );
}

function Shell({ guide, lead, faq, children }: { guide: TripGuide; lead: string | null; faq: readonly LandingFaq[]; children: React.ReactNode }) {
  return (
    <main className="ds-page" lang="ru" data-guide={guide.key}>
      <JsonLd data={guideJsonLd(guide, faq)} />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <header className="space-y-3">
          <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>{guide.h1}</h1>
          {lead && <p className="text-base" style={{ color: 'var(--text-primary)' }} data-guide-lead>{lead}</p>}
        </header>
        {children}
        <Faq faq={faq} />
        <GuideFooter self={guide} />
      </div>
    </main>
  );
}

function ToursState({ tours }: { tours: LandingTourRow[] | null }) {
  if (tours === null) {
    return <p className="ds-card p-4 text-sm" style={{ color: 'var(--warning)' }} data-guide-unavailable>{UNAVAILABLE} <Link className="underline" href="/catalog">Каталог</Link></p>;
  }
  return <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>{EMPTY}</p>;
}

export function TripCostView({ tours, stay }: { tours: LandingTourRow[] | null; stay: StayPrices | null }) {
  const faq = costFaq(tours, stay);
  const hasTours = tours !== null && tours.length > 0;
  const byActivity = hasTours ? costByActivity(tours) : [];
  const byTopic = hasTours ? costByTopic(tours) : [];
  return (
    <Shell guide={TRIP_COST} lead={costLead(tours)} faq={faq}>
      <section className="space-y-3" aria-labelledby="cost-activity">
        <h2 id="cost-activity" className="ds-h2">Туры по видам</h2>
        {!hasTours ? <ToursState tours={tours} /> : (
          <>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{COST_ORDER_NOTE}</p>
            <ul className="space-y-2">
              {byActivity.map((a) => (
                <li key={a.activity || 'other'} className="ds-card p-4 text-sm space-y-1" data-cost-activity={a.activity || 'other'}>
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{a.label} · {toursWord(a.count)}</p>
                  {a.spans.map((s) => <p key={s.unit} style={{ color: 'var(--text-primary)' }}>{spanWords(s)}</p>)}
                  {a.unpriced > 0 && <p style={{ color: 'var(--text-secondary)' }}>У {a.unpriced} цена записана иначе или не записана — она в карточке тура.</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {byTopic.length > 0 && (
        <section className="space-y-3" aria-labelledby="cost-topic">
          <h2 id="cost-topic" className="ds-h2">По направлениям</h2>
          <ul className="space-y-2">
            {byTopic.map((x) => (
              <li key={x.landing.path} className="ds-card p-4 text-sm space-y-1" data-cost-topic={x.landing.topic}>
                <Link className="underline font-semibold" style={linkStyle} href={x.landing.path}>{x.landing.h1}</Link>
                <p style={{ color: 'var(--text-primary)' }}>{x.spans.length ? x.spans.map(spanWords).join('; ') : `${toursWord(x.count)}, цена не записана`}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="cost-stay">
        <h2 id="cost-stay" className="ds-h2">Жильё</h2>
        <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          <p data-cost-stay>{stay ? stayPriceWords(stay) : 'Цены жилья не загрузились: база не ответила.'}</p>
          <Link className="underline" style={linkStyle} href="/accommodations">Жильё на Ведаре</Link>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="cost-road">
        <h2 id="cost-road" className="ds-h2">Перелёт и трансфер</h2>
        <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          <p>{FLIGHT_PRICE_WORDS} <Link className="underline" style={linkStyle} href="/flights">Табло Елизово</Link></p>
          <p>{TRANSFER_PRICE_WORDS} <Link className="underline" style={linkStyle} href="/transfers">Перевозчики и прайс</Link></p>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="cost-total">
        <h2 id="cost-total" className="ds-h2">Сколько всего</h2>
        <div className="ds-card p-4 text-sm space-y-3" style={{ color: 'var(--text-primary)' }}>
          <p>{TOTAL_PRICE_WORDS}</p>
          <p>Ведар оплату не принимает: тур оплачивается оператору напрямую, жильё — хозяину.</p>
          <Link className="ds-btn ds-btn-primary" href="/request">Оставить заявку на подбор тура</Link>
        </div>
      </section>
    </Shell>
  );
}

export function TripSeasonView({ tours }: { tours: LandingTourRow[] | null }) {
  const table = tours && tours.length > 0 ? seasonTable(tours) : null;
  const faq = seasonFaq(table);
  return (
    <Shell guide={TRIP_SEASON} lead={seasonLead(table)} faq={faq}>
      <section className="space-y-3" aria-labelledby="season-months">
        <h2 id="season-months" className="ds-h2">По месяцам</h2>
        {!table ? <ToursState tours={tours} /> : (
          <>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Туры месяца — по сезонам, которые операторы записали в карточках туров на Ведаре. Рыба — по <Link className="underline" style={linkStyle} href="/fish">справочнику рыб</Link>.
              {table.withoutSeason > 0 ? ` У ${table.withoutSeason} из ${tours!.length} туров сезон не записан, в таблице их нет.` : ''}
            </p>
            <ol className="space-y-2">
              {table.months.map((m) => (
                <li key={m.month} className="ds-card p-4 text-sm space-y-1" data-season-month={m.month}>
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{m.name} · {m.tours > 0 ? toursWord(m.tours) : 'туров нет'}</p>
                  {m.activities.length > 0 && (
                    <p style={{ color: 'var(--text-primary)' }}>{m.activities.map((a) => `${a.label} ${a.count}`).join(' · ')}</p>
                  )}
                  {m.topics.length > 0 && (
                    <p className="flex flex-wrap gap-x-3">
                      {m.topics.map((t) => (
                        <Link key={t.landing.path} className="underline" style={linkStyle} href={t.landing.path}>{t.landing.h1} ({t.count})</Link>
                      ))}
                    </p>
                  )}
                  {m.fish.length > 0 && (
                    <p style={{ color: 'var(--text-secondary)' }}>
                      Рыба:{' '}
                      {m.fish.map((f, i) => (
                        <span key={f.id}>{i > 0 ? ', ' : ''}<Link className="underline" style={linkStyle} href={`/fish/${f.id}`}>{f.name}</Link></span>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="ds-h2">Выбрать дату</h2>
        <div className="ds-card p-4 text-sm space-y-3" style={{ color: 'var(--text-primary)' }}>
          <p>Свободные даты конкретного тура — в его карточке и в календаре туров: туда операторы записывают выезды.</p>
          <Link className="ds-btn ds-btn-primary" href="/calendar">Календарь туров</Link>
        </div>
      </section>
    </Shell>
  );
}
