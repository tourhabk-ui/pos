/**
 * Страница перевозчика /transfers/[slug] — стандарт карточки трансфера
 * (решение владельца 13.10, «да делай»; CLAUDE.md §14). По образцу карточки
 * тура (§11), сверху вниз:
 *
 *   герой (фото, крошки, заголовок, полоса фактов) → фото и видео → о
 *   перевозчике → прайс под заказ (направления ведут на места) → что входит
 *   в цену → безопасность по направлениям → перевозчик (исполнитель, отметка
 *   проверки, связь) → отзывы → Кузьмич; справа — закреплённая заявка на
 *   машину. Мест в поездках нет: машину заказывают целиком (владелец 13.10).
 *
 * Единственная реализация: прежде перевозчик открывался в шаблоне
 * туроператора (/operators/[slug]) — с подписью «Проверенный оператор», FAQ
 * про туры и без формы заказа. Отзывы — только от тех, кто ехал, и каждый
 * называет доказательство поездки (слово владельца 13.10 «делай блок отзывов
 * но логично», components/transfers/CarrierReviews).
 *
 * Компонент без хуков: страница рисуется на сервере, интерактивны только
 * герой (просмотрщик фото), лента фото и форма заявки.
 */

import Image from 'next/image';
import Link from 'next/link';
import { ChevronRight, ShieldCheck, Phone, Send, MessageCircle, AlertTriangle, MessageSquare } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { LazyClip } from '@/components/media/LazyClip';
import { HazardBadgeStrip } from '@/components/shared/HazardBadgeStrip';
import { CharterPhotos } from '@/components/transfers/CharterPhotos';
import { CharterPriceList } from '@/components/transfers/CharterPriceList';
import { CarrierHero } from '@/components/transfers/CarrierHero';
import { CharterRequestForm } from '@/components/transfers/CharterRequestForm';
import { CarrierReviews } from '@/components/transfers/CarrierReviews';
import { CarrierVideo } from '@/components/transfers/CarrierVideo';
import { formatContactPhone } from '@/lib/stay/contact-phone';
import {
  CHARTER_REQUEST_ANCHOR, INSURANCE_WORDS_LINE, charterRequisitesLine, describeFleet, formatRub, licenseLine,
  orderDestinationFromQuery, rateOnScreen,
} from '@/lib/transfers/charter-format';
import { photoSrc } from '@/lib/images/variant';
import { carrierInstrument, includedUnknowns, minCharterPrice } from '@/lib/transfers/carrier-view';
import type { CarrierPageData } from '@/lib/transfers/carrier-page';

/** Якорь формы заявки: на него ведут кнопка героя, «Заказать» у строк прайса и ссылки снаружи. */
export { CHARTER_REQUEST_ANCHOR };

const CRUMB = 'inline-flex items-center min-h-[44px] px-1 text-white/85 hover:text-white visited:text-white/85 hover:no-underline transition-colors';

function H2({ id, children }: { id?: string; children: React.ReactNode }) {
  return <h2 id={id} className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-4">{children}</h2>;
}

/**
 * `orderTo` — направление из адреса заявки (`?to=`, «Заказать» у строки
 * прайса): форма открывается с ним выбранным. Не строка прайса — не берётся.
 */
export function CarrierPage({ data, orderTo }: { data: CarrierPageData; orderTo?: unknown }) {
  const { carrier: c, safety, reviews } = data;
  const instrument = carrierInstrument(c);
  const minPrice = minCharterPrice(c);
  const phoneLabel = formatContactPhone(c.phone);
  const linked = c.destinations.filter((d) => d.place);
  const fleet = describeFleet(c.vehicles);
  const destinations = c.destinations.map((d) => d.to);
  const preselected = orderDestinationFromQuery(destinations, orderTo);

  return (
    <div style={{ background: 'var(--bg-primary)' }}>
      <Header overPhoto />

      <CarrierHero name={c.name} photos={c.photos}>
        <nav aria-label="Хлебные крошки" className="flex items-center gap-1 text-[13px] mb-2 -ml-1">
          <Link href="/" className={CRUMB}>Главная</Link>
          <ChevronRight className="w-3 h-3 text-white/60" aria-hidden />
          <Link href="/transfers" className={CRUMB}>Трансферы</Link>
        </nav>
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-white mb-2">Перевозчик · под заказ</p>
        <h1 className="font-playfair text-white font-bold leading-tight" style={{ fontSize: 'clamp(30px,5vw,52px)' }}>{c.name}</h1>
        {c.shortDescription && (
          <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-white/90">{c.shortDescription}</p>
        )}
        {instrument.length > 0 && (
          <dl className="mt-5 inline-flex flex-wrap rounded-2xl overflow-hidden backdrop-blur-md bg-black/40 border border-white/15" aria-label="Факты о перевозчике">
            {instrument.map((cell) => (
              <div key={cell.k} className="px-4 py-2.5">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-white/70">{cell.k}</dt>
                <dd className="text-[14px] font-semibold text-white mt-1">{cell.v}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-5">
          <a href={`#${CHARTER_REQUEST_ANCHOR}`} className="ds-btn ds-btn-primary inline-flex items-center gap-2" style={{ minHeight: 44 }}>
            <Send className="w-4 h-4" aria-hidden /> Заявка на машину
          </a>
        </div>
      </CarrierHero>

      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 pt-6 pb-16">
          <div className="lg:col-span-8 space-y-12">

            {(c.photos.length > 1 || c.clips.length > 0 || c.video) && (
              <section aria-label={`Фото и видео: ${c.name}`} className="space-y-4">
                {c.photos.length > 1 && <CharterPhotos name={c.name} photos={c.photos.slice(1)} />}
                {c.clips.length > 0 && (
                  <ul className="flex gap-2 overflow-x-auto pb-2 snap-x" aria-label={`Короткие видео: ${c.name}`}>
                    {c.clips.map((clip) => (
                      <li key={clip.url} className="snap-start shrink-0 w-64">
                        <LazyClip url={clip.url} poster={clip.poster} label={clip.label} className="aspect-video" />
                      </li>
                    ))}
                  </ul>
                )}
                {c.video && <CarrierVideo video={c.video} name={c.name} />}
              </section>
            )}

            {c.description && (
              <section>
                <H2>О перевозчике</H2>
                <p className="text-[var(--text-secondary)] leading-relaxed">{c.description}</p>
              </section>
            )}

            {(c.destinations.length > 0 || c.extraDay || c.rates.length > 0) && (
              <section aria-labelledby="carrier-price">
                <H2 id="carrier-price">Прайс под заказ</H2>
                <div className="ds-card px-5 py-3">
                  <CharterPriceList carrier={c} orderSlug={c.slug} />
                </div>
              </section>
            )}


            <section aria-labelledby="carrier-included">
              <H2 id="carrier-included">Что входит в цену</H2>
              <p className="text-sm text-[var(--text-secondary)]">
                Перевозчик этого не записал: {includedUnknowns(c)} — уточняется у перевозчика при заказе. Оплата —
                напрямую ему: через Ведар машина не оплачивается.
              </p>
            </section>

            <section aria-labelledby="carrier-safety">
              <H2 id="carrier-safety">Безопасность по направлениям</H2>
              {safety.state === 'failed' ? (
                <p className="text-sm text-[var(--text-secondary)]">
                  Не смогли проверить опасности мест — это сбой, а не «опасностей нет». Смотрите карточки мест.
                </p>
              ) : c.destinations.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">
                  Направлений в прайсе нет: куда ехать, задаёте вы, — опасности места смотрите в его карточке на Ведаре.
                </p>
              ) : linked.length > 0 && (
                <ul className="space-y-4">
                  {linked.map((d) => {
                    const place = d.place!;
                    const hazards = safety.byPlace[place.id] ?? [];
                    return (
                      <li key={place.id}>
                        <Link href={place.href} className="font-semibold text-[var(--ocean)] hover:underline">{place.name}</Link>
                        {hazards.length > 0 ? (
                          <HazardBadgeStrip hazards={hazards} className="mt-2" />
                        ) : (
                          <p className="text-xs text-[var(--text-muted)] mt-1">Опасности места не записаны — это не значит, что их нет.</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* 112 — словами: вызов несёт кнопка SOS в шапке (EmergencyAction, с
                  офлайн-веткой); вторая ссылка на tel:112 — вторая копия SOS (#887). */}
              <p className="text-sm text-[var(--text-secondary)] mt-4">
                Перед выездом — <Link href="/safety" className="text-[var(--ocean)] hover:underline">обстановка в крае</Link>.
                Экстренный вызов — 112, кнопка SOS в шапке.
              </p>
            </section>

            <section aria-labelledby="carrier-who">
              <H2 id="carrier-who">Перевозчик</H2>
              {/* Как «Кто проводит» на карточке тура (§11): вывеска перевозчика,
                  под ней — исполнитель по договору из legal_info (владелец 13.10:
                  «Шатун», а ИП — в карточку компании, как у туров). */}
              <div className="ds-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="w-14 h-14 rounded-full overflow-hidden shrink-0 relative bg-[var(--bg-hover)] flex items-center justify-center" aria-hidden>
                    {c.photos[0] ? (
                      <Image src={photoSrc(c.photos[0].url, 320)} alt="" fill className="object-cover" sizes="56px" />
                    ) : (
                      <span className="font-playfair text-xl font-bold text-[var(--text-primary)]">{c.name.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-[10rem]">
                    <p className="font-playfair font-semibold text-[var(--text-primary)]">{c.name}</p>
                    {fleet && <p className="text-xs text-[var(--text-secondary)] mt-0.5">{fleet}</p>}
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                      Исполнитель: {charterRequisitesLine(c.legal) ?? 'реквизиты перевозчика не записаны на платформе'}
                    </p>
                    {/* Лицензия и страхование — только записанное и с источником:
                        номер по выписке — со статусом на дату выписки; «есть» со
                        слов — так и сказано (владелец 15.10: «только факты»). */}
                    {c.license && (
                      <p className="text-xs text-[var(--text-muted)] mt-1">{licenseLine(c.license)}.</p>
                    )}
                    {c.passengerInsurance === 'words' && (
                      <p className="text-xs text-[var(--text-muted)] mt-1">{INSURANCE_WORDS_LINE}.</p>
                    )}
                    {c.verified && (
                      <p className="text-[13px] text-[var(--success)] flex items-center gap-1.5 mt-1">
                        <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden /> Проверенный перевозчик
                      </p>
                    )}
                  </div>
                </div>
                {c.phone || c.telegramHref || c.whatsappHref ? (
                  <div className="flex flex-wrap gap-2">
                    {c.phone && phoneLabel && (
                      <a href={`tel:${c.phone}`} className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                        <Phone className="w-4 h-4" aria-hidden /> Позвонить {phoneLabel}
                      </a>
                    )}
                    {c.telegramHref && (
                      <a href={c.telegramHref} target="_blank" rel="noopener noreferrer nofollow" className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                        <Send className="w-4 h-4" aria-hidden /> Telegram
                      </a>
                    )}
                    {c.whatsappHref && (
                      <a href={c.whatsappHref} target="_blank" rel="noopener noreferrer nofollow" className="ds-btn ds-btn-secondary inline-flex items-center gap-2">
                        <MessageCircle className="w-4 h-4" aria-hidden /> WhatsApp
                      </a>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-secondary)]">Контакты перевозчика не записаны — заявка дойдёт через менеджера Ведара.</p>
                )}
              </div>
            </section>

            <CarrierReviews reviews={reviews} />

            <section aria-labelledby="carrier-kuzmich">
              <H2 id="carrier-kuzmich">Спросить Кузьмича</H2>
              <Link href="/kuzmich" className="ds-card p-5 flex items-start gap-3 hover:bg-[var(--bg-hover)] transition-colors">
                <MessageSquare className="w-5 h-5 text-[var(--accent)] shrink-0 mt-0.5" aria-hidden />
                <span className="text-sm text-[var(--text-secondary)]">
                  Как доехать, что взять с собой, какая обстановка на месте. Кузьмич знает прайс перевозчиков и сводку по
                  краю — спросите, например: «сколько стоит машина на Горелый и что взять».
                </span>
              </Link>
            </section>
          </div>

          <aside className="lg:col-span-4">
            <div className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
              {/* scroll-mt на lg равен отступу закреплённой колонки: «Заказать»
                  в прайсе не дёргает страницу, когда форма и так на экране. */}
              <section id={CHARTER_REQUEST_ANCHOR} className="ds-card p-5 scroll-mt-24 lg:scroll-mt-20" aria-labelledby="charter-request-title">
                <h2 id="charter-request-title" className="font-playfair text-xl font-bold text-[var(--text-primary)]">Заявка на машину</h2>
                {minPrice !== null ? (
                  <p className="text-sm text-[var(--text-secondary)] mt-1">
                    от <span className="font-semibold text-[var(--accent)]">{formatRub(minPrice)}</span> за машину по прайсу
                  </p>
                ) : c.rates.length > 0 && (
                  <p className="text-sm text-[var(--text-secondary)] mt-1">
                    {c.rates.map((r, i) => (
                      <span key={r.unit}>
                        {i > 0 && ' · '}
                        <span className="font-semibold text-[var(--accent)] whitespace-nowrap">{rateOnScreen(r)}</span>
                      </span>
                    ))}
                    {' '}за машину; куда ехать — пишете в заявке
                  </p>
                )}
                <div className="mt-4">
                  {/* «Заказать» у другой строки прайса — та же страница, другой
                      ?to=: форма берёт направление, не теряя введённого. */}
                  <CharterRequestForm
                    carrierSlug={c.slug}
                    carrierName={c.name}
                    destinations={destinations}
                    initialDestination={preselected}
                    rates={c.rates}
                  />
                </div>
              </section>
            </div>
          </aside>
        </div>
      </div>
      <Footer />
    </div>
  );
}
