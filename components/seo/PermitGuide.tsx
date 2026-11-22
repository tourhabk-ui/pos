/**
 * Страница «Нужно ли разрешение на посещение» (#3566 п.5). Факты — только из
 * lib/safety/park-permit через lib/seo/permit-guide: та же правда, что на
 * карточке маршрута. Чего в справочнике нет, того нет и здесь.
 */
import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import {
  FEDERAL_PERMIT_UNKNOWN_RU, FEDERALIZED_PARKS, FREE_VISIT_AREAS, GREEN_BUTTON, KRONOKI_ORDER_RU, KRONOKI_REQUESTS,
  KRONOKI_TERRITORIES, NO_PERMIT_TERRITORIES, PARK_PERMIT_CHANNELS, PARK_PERMIT_SOURCE, PERMIT_GUIDE_AUTHOR,
  PERMIT_GUIDE_DATE, PERMIT_GUIDE_H1, PERMIT_NOT_MCHS_RU,
  ROUTE_PASSPORTS_REGISTRY, VOLCANOES_DECREE_DOC, federalizedParksRu, permitArticleJsonLd, permitBreadcrumbJsonLd, permitFaq,
} from '@/lib/seo/permit-guide';
import { formatRecordDate, recordDateIso } from '@/lib/seo/record-modified';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{children}</p>;
}

function Source({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
      Источник: <a className="underline" style={{ color: 'var(--ocean)' }} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    </p>
  );
}

export function PermitGuideView() {
  const faq = permitFaq();
  const federal = FEDERALIZED_PARKS[0];
  const reviewed = formatRecordDate(PERMIT_GUIDE_DATE);
  return (
    <main className="ds-page" data-permit-guide>
      <JsonLd data={permitArticleJsonLd(SITE)} />
      <JsonLd data={permitBreadcrumbJsonLd(SITE)} />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <header className="space-y-3">
          <nav className="landing-crumbs text-sm" aria-label="Хлебные крошки">
            <Link href="/">Главная</Link>
            <span aria-hidden="true"> · </span>
            <span aria-current="page">{PERMIT_GUIDE_H1}</span>
          </nav>
          <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {PERMIT_GUIDE_H1}
          </h1>
          {reviewed && (
            <p className="text-xs text-[var(--text-muted)]" data-record-modified="">
              {PERMIT_GUIDE_AUTHOR} · факты проверены{' '}
              <time dateTime={recordDateIso(PERMIT_GUIDE_DATE) ?? undefined}>{reviewed}</time>
            </p>
          )}
          <p className="text-base" style={{ color: 'var(--text-primary)' }}>
            Многие маршруты края проходят по охраняемым территориям — природным паркам, заповедникам и заказникам.
            Туда нужно разрешение того, кто управляет территорией. Ниже — кто и как его выдаёт, по официальным страницам, с датой сверки.
          </p>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{PERMIT_NOT_MCHS_RU}</p>
          <Muted>
            Регистрацию группы в МЧС делают отдельно — <Link className="underline" style={{ color: 'var(--ocean)' }} href="/register">форма регистрации выхода</Link>.
          </Muted>
        </header>

        <section className="space-y-3" aria-labelledby="permit-park">
          <h2 id="permit-park" className="ds-h2">Природные парки «Вулканы Камчатки»</h2>
          <Muted>Разрешение выдаёт {PARK_PERMIT_SOURCE.authority}. Способы, которые называет парк:</Muted>
          <ul className="space-y-2">
            {PARK_PERMIT_CHANNELS.map((c) => (
              <li key={c.key} className="ds-card p-4 text-sm">
                <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{c.key === 'green_button' ? `Приложение «${c.title}»` : c.title}</p>
                <p style={{ color: 'var(--text-secondary)' }}>{c.detail}</p>
                {c.key === 'green_button' ? (
                  <p className="mt-1">
                    <a className="underline" style={{ color: 'var(--ocean)' }} href={GREEN_BUTTON.androidUrl} target="_blank" rel="noopener noreferrer">Android</a>
                    {GREEN_BUTTON.iosUrl ? <> · <a className="underline" style={{ color: 'var(--ocean)' }} href={GREEN_BUTTON.iosUrl} target="_blank" rel="noopener noreferrer">iPhone</a></> : null}
                  </p>
                ) : c.href ? (
                  <p className="mt-1"><a className="underline" style={{ color: 'var(--ocean)' }} href={c.href} target="_blank" rel="noopener noreferrer">{c.href}</a></p>
                ) : null}
              </li>
            ))}
          </ul>
          <Muted>Зона свободного посещения, где разрешение парка не требуется: {FREE_VISIT_AREAS.join(', ')}.</Muted>
          <Source href={PARK_PERMIT_SOURCE.url}>{PARK_PERMIT_SOURCE.authority}, {PARK_PERMIT_SOURCE.asOf}</Source>
          {federal ? (
            <div className="ds-card p-4 text-sm space-y-1" style={{ borderLeft: '3px solid var(--warning)' }}>
              <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                Парки {federalizedParksRu()} с {federal.since} — часть национального парка {federal.nationalPark}
              </p>
              <p style={{ color: 'var(--text-secondary)' }}>{FEDERAL_PERMIT_UNKNOWN_RU}</p>
              <Source href={VOLCANOES_DECREE_DOC.url}>{VOLCANOES_DECREE_DOC.title}</Source>
            </div>
          ) : null}
        </section>

        <section className="space-y-3" aria-labelledby="permit-kronoki">
          <h2 id="permit-kronoki" className="ds-h2">Кроноцкий заповедник, Долина гейзеров, Курильское озеро</h2>
          <Muted>
            Территории {KRONOKI_REQUESTS.authority}: {KRONOKI_TERRITORIES.map((t) => t.name).join(', ')}.
            Каналы краевого парка («{GREEN_BUTTON.name}», Госуслуги41, офис в Елизово) к ним отношения не имеют.
          </Muted>
          <p className="ds-card p-4 text-sm" style={{ color: 'var(--text-primary)' }}>{KRONOKI_ORDER_RU}</p>
          <Source href={KRONOKI_REQUESTS.url}>{KRONOKI_REQUESTS.authority}, страница заявок, {KRONOKI_REQUESTS.asOf}</Source>
        </section>

        {NO_PERMIT_TERRITORIES.length > 0 ? (
          <section className="space-y-3" aria-labelledby="permit-none">
            <h2 id="permit-none" className="ds-h2">Где разрешение не нужно по режиму территории</h2>
            <ul className="space-y-2">
              {NO_PERMIT_TERRITORIES.map((t) => (
                <li key={t.match} className="ds-card p-4 text-sm space-y-1">
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t.name}</p>
                  <p style={{ color: 'var(--text-secondary)' }}>{t.basis[0].toUpperCase() + t.basis.slice(1)}.</p>
                  <Source href={t.url}>{t.authority}, {t.asOf}</Source>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-3" aria-labelledby="permit-passports">
          <h2 id="permit-passports" className="ds-h2">Официальные паспорта маршрутов</h2>
          <Muted>
            Паспорт маршрута — описание пути, сложности и правил от того, кто его утвердил. Все паспорта края — в{' '}
            <a className="underline" style={{ color: 'var(--ocean)' }} href={ROUTE_PASSPORTS_REGISTRY.url} target="_blank" rel="noopener noreferrer">{ROUTE_PASSPORTS_REGISTRY.title}</a>.
            На карточке маршрута Ведара ссылка на паспорт и условия посещения территории стоят, если они записаны.
          </Muted>
          <Muted>
            Порядок для территорий, которых нет на этой странице, на Ведаре не записан — карточка маршрута скажет об этом прямо, а не «разрешение не нужно».
            {' '}<Link className="underline" style={{ color: 'var(--ocean)' }} href="/routes">Маршруты</Link>
          </Muted>
        </section>

        <section className="space-y-3" aria-labelledby="permit-faq">
          <h2 id="permit-faq" className="ds-h2">Частые вопросы</h2>
          <dl className="space-y-3">
            {faq.map((f) => (
              <div key={f.q} className="ds-card p-4 text-sm">
                <dt className="font-semibold" style={{ color: 'var(--text-primary)' }}>{f.q}</dt>
                <dd style={{ color: 'var(--text-secondary)' }}>{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  );
}
