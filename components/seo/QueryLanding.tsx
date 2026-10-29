/**
 * Посадочная страница под поисковый запрос (lib/seo/query-landings).
 * Серверный компонент: данные приходят готовыми и упорядоченными.
 */
import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { tourPath } from '@/lib/tours/tour-url';
import { zhTourPath } from '@/lib/zh/pages';
import { zhFactHeading } from '@/lib/zh/entry';
import { siblingLandings, type LandingLang, type QueryLanding } from '@/lib/seo/query-landings';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import { chronicleForTopic } from '@/lib/seo/query-landings-chronicle';
import { CHRONICLE_ARTICLES } from '@/lib/chronicle/articles';
import type { ParkListItem } from '@/lib/parks/list';
import { OFFER_ORDER_NOTE } from '@/lib/tours/offer-order';
import { landingDates, landingDuration, landingJsonLd, landingPrice, landingSeason } from '@/lib/seo/query-landing-view';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

const UI: Record<LandingLang, {
  tours: string; unavailable: string; empty: string; order: string; operator: string; card: string;
  how: string; howText: string; cta: string; ai: string; aiText: string; faq: string; more: string; noPrice: string; chronicle: string; chronicleNote: string; chronicleAll: string; parks: string;
}> = {
  'zh-CN': {
    tours: '团队游', unavailable: '目录暂时不可用：数据库未响应。请稍后再试。', empty: '目前没有符合条件的已发布团队游。',
    order: OFFER_ORDER_NOTE.zh, operator: '旅行社', card: '俄文原页（预订）',
    how: '如何预订', howText: '打开团队游的俄文原页，提交预订申请。申请由人工确认；无在线支付，款项直接付给旅行社。',
    cta: '提交选团申请', ai: 'AI 助手接入', aiText: 'AI 助手可通过 MCP 服务器查询本页同一数据库中的团队游：', faq: '常见问题', more: '更多页面', noPrice: '价格以旅行社确认为准',
    chronicle: '堪察加编年史', chronicleNote: '有出处的历史文章（俄文）：', chronicleAll: '全部文章（俄文）', parks: '相关自然公园与保护区（俄文页面）',
  },
  ru: {
    tours: 'Туры', unavailable: 'Список не загрузился: база не ответила. Попробуйте позже или откройте каталог.', empty: 'Сейчас нет опубликованных туров по этой теме.',
    order: OFFER_ORDER_NOTE.ru, operator: 'Оператор', card: 'Карточка и заявка',
    how: 'Как проходит бронирование', howText: 'Откройте карточку тура и оставьте заявку. Её получает оператор, подтверждает человек. Онлайн-оплаты нет — оплата оператору напрямую.',
    cta: 'Оставить заявку на подбор тура', ai: 'Ведар для ИИ-ассистентов', aiText: 'Те же туры доступны ИИ-ассистентам через открытый MCP-сервер:', faq: 'Частые вопросы', more: 'Ещё по теме', noPrice: 'цена не указана',
    chronicle: 'Летопись Камчатки', chronicleNote: 'Статьи с источниками:', chronicleAll: 'Все статьи летописи', parks: 'Парки и заказники по теме',
  },
  en: {
    tours: 'Tours', unavailable: 'The list did not load: the database did not respond. Please try again later.', empty: 'No published tours on this topic right now.',
    order: OFFER_ORDER_NOTE.en, operator: 'Operator', card: 'Tour card & request (Russian)',
    how: 'How booking works', howText: 'Open the tour card and send a request. The operator receives it and a person confirms it. No online payment — you pay the operator directly.',
    cta: 'Send a tour request', ai: 'For AI assistants', aiText: 'The same tours are available to AI assistants via an open MCP server:', faq: 'FAQ', more: 'See also', noPrice: 'price not specified',
    chronicle: 'Kamchatka Chronicle', chronicleNote: 'Sourced history articles (in Russian):', chronicleAll: 'All chronicle articles (in Russian)', parks: 'Related nature parks and reserves (pages in Russian)',
  },
};

export function QueryLandingView({ landing, tours, parks = [] }: { landing: QueryLanding; tours: LandingTourRow[] | null; parks?: ParkListItem[] | null }) {
  const ui = UI[landing.lang];
  const zh = landing.lang === 'zh-CN';
  const chronicle = chronicleForTopic(landing.topic);
  return (
    <main className="ds-page" lang={landing.lang} data-landing={landing.key}>
      <JsonLd data={landingJsonLd(landing, tours, SITE)} />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <header className="space-y-3">
          <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>{landing.h1}</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{landing.intro}</p>
        </header>

        <section className="space-y-3" aria-labelledby="landing-tours">
          <h2 id="landing-tours" className="ds-h2">{ui.tours}{tours ? ` (${tours.length})` : ''}</h2>
          {tours === null ? (
            <p className="ds-card p-4 text-sm" style={{ color: 'var(--warning)' }}>{ui.unavailable} <Link className="underline" href="/catalog">/catalog</Link></p>
          ) : tours.length === 0 ? (
            <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>{ui.empty}</p>
          ) : (
            <>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{ui.order}</p>
              <ul className="space-y-2">
                {tours.map((t) => (
                  <li key={t.id} className="ds-card p-4 text-sm space-y-1" data-landing-tour={t.id}>
                    {zh ? (
                      <>
                        <Link className="underline font-semibold" style={{ color: 'var(--ocean)' }} href={zhTourPath(t)}>{t.title_zh ?? zhFactHeading(t)}</Link>
                        <p style={{ color: 'var(--text-secondary)' }}>俄文原名：<span lang="ru">{t.title}</span></p>
                      </>
                    ) : (
                      <Link className="underline font-semibold" style={{ color: 'var(--ocean)' }} href={tourPath(t)} lang="ru">{t.title}</Link>
                    )}
                    <p style={{ color: 'var(--text-secondary)' }}>
                      {ui.operator}: <span lang="ru"><OperatorNameLink name={t.operator_name} slug={t.operator_slug} isPublic={t.operator_public} /></span>
                    </p>
                    <p style={{ color: 'var(--text-primary)' }}>
                      {[landingPrice(t, landing.lang) ?? ui.noPrice, landingDuration(t, landing.lang), landingSeason(t, landing.lang), landingDates(t, landing.lang)].filter(Boolean).join(' · ')}
                    </p>
                    <Link className="underline" style={{ color: 'var(--ocean)' }} href={tourPath(t)}>{ui.card}</Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="ds-h2">{ui.how}</h2>
          <div className="ds-card p-4 text-sm space-y-3" style={{ color: 'var(--text-primary)' }}>
            <p>{ui.howText}</p>
            <Link className="ds-btn ds-btn-primary" href="/request" data-landing-cta>{ui.cta}</Link>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="ds-h2">{ui.ai}</h2>
          <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-primary)' }}>
            {ui.aiText} <code>{SITE}/api/mcp</code>{' · '}
            <Link className="underline" style={{ color: 'var(--ocean)' }} href={zh ? '/zh#connect' : '/mcp'}>{zh ? '接入说明' : landing.lang === 'ru' ? 'как подключить' : 'how to connect'}</Link>
          </p>
        </section>

        {parks && parks.length > 0 && (
          <section className="space-y-3" data-landing-parks>
            <h2 className="ds-h2">{ui.parks}</h2>
            <ul className="ds-card p-4 text-sm list-disc list-inside space-y-1">
              {parks.map((p) => (
                <li key={p.slug}><Link className="underline" style={{ color: 'var(--ocean)' }} href={`/park/${p.slug}`} lang="ru">{p.displayName}</Link></li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-3" data-landing-chronicle>
          <h2 className="ds-h2">{ui.chronicle}</h2>
          <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
            <p>{ui.chronicleNote}</p>
            {chronicle.length > 0 && (
              <ul className="list-disc list-inside space-y-1">
                {chronicle.map((a) => (
                  <li key={a.slug}><Link className="underline" style={{ color: 'var(--ocean)' }} href={`/letopis/${a.slug}`} lang="ru">{a.title}</Link></li>
                ))}
              </ul>
            )}
            <Link className="underline" style={{ color: 'var(--ocean)' }} href="/letopis">{ui.chronicleAll} ({CHRONICLE_ARTICLES.length})</Link>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="ds-h2">{ui.faq}</h2>
          <dl className="space-y-3">
            {landing.faq.map((f) => (
              <div key={f.q} className="ds-card p-4 text-sm">
                <dt className="font-semibold" style={{ color: 'var(--text-primary)' }}>{f.q}</dt>
                <dd style={{ color: 'var(--text-secondary)' }}>{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <footer className="text-sm space-x-3" style={{ color: 'var(--text-secondary)' }}>
          <span>{ui.more}:</span>
          {siblingLandings(landing).map((s) => <Link key={s.key} className="underline" href={s.path}>{s.h1}</Link>)}
          <Link className="underline" href={zh ? '/zh' : '/catalog'}>{zh ? 'Vedar 中文首页' : landing.lang === 'ru' ? 'Каталог туров' : 'Full catalog (Russian)'}</Link>
        </footer>
      </div>
    </main>
  );
}
