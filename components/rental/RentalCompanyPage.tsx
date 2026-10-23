/**
 * Страница прокатчика /car-rental/[slug] — витрина проката (решение владельца
 * 23.10 «пока берем аренду автомобилей и трансфер»), по образцу страницы
 * перевозчика (§14). Сверху вниз:
 *
 *   герой (фото или знак машины, крошки, заголовок, полоса фактов) → о
 *   прокатчике → машины и цены → условия проката → прокатчик (исполнитель,
 *   отметка проверки, связь) → если партнёр ещё и перевозчик — ссылка на
 *   прайс машины с водителем → Кузьмич; справа — закреплённая заявка.
 *
 * Правило одно на все блоки: только записанное. Нет описания — «описание не
 * записано»; нет условий — «условия на платформе не записаны»; что входит в
 * цену, минимальный срок, возраст и стаж — не записаны нигде, и страница
 * говорит это всегда (§4.0). «Проверенный прокатчик» — только по отметке.
 *
 * Компонент без хуков: страница рисуется на сервере, интерактивны только
 * герой (просмотрщик фото), лента фото и форма заявки.
 */

import Image from 'next/image';
import Link from 'next/link';
import { Bus, ChevronRight, Phone, Send, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { CharterPhotos } from '@/components/transfers/CharterPhotos';
import { KuzmichActions } from '@/components/shared/KuzmichActions';
import { RentalHero } from '@/components/rental/RentalHero';
import { PartnerLogo } from '@/components/shared/PartnerLogo';
import { RentalOfferList } from '@/components/rental/RentalOfferList';
import { RentalRequestForm } from '@/components/rental/RentalRequestForm';
import { formatContactPhone } from '@/lib/stay/contact-phone';
import { photoSrc } from '@/lib/images/variant';
import { carrierPagePath, formatRub } from '@/lib/transfers/charter-format';
import {
  RENTAL_REQUEST_ANCHOR, minRentalPrice, orderOfferFromQuery, rentalRequisitesLine, rentalUnknownsText,
} from '@/lib/rental/rental-format';
import { rentalInstrument } from '@/lib/rental/rental-view';
import type { RentalPageData } from '@/lib/rental/rental-page';

/** Якорь формы заявки: на него ведут кнопка героя, «Заказать» у строк прайса и ссылки снаружи. */
export { RENTAL_REQUEST_ANCHOR };

const CRUMB = 'inline-flex items-center min-h-[44px] px-1 text-white/85 hover:text-white visited:text-white/85 hover:no-underline transition-colors';

function H2({ id, children }: { id?: string; children: React.ReactNode }) {
  return <h2 id={id} className="font-playfair text-2xl font-bold text-[var(--text-primary)] mb-4">{children}</h2>;
}

/**
 * `orderCar` — машина из адреса заявки (`?car=`, «Заказать» у строки прайса):
 * форма открывается с ней выбранной. Не строка прайса — не берётся.
 */
export function RentalCompanyPage({ data, orderCar }: { data: RentalPageData; orderCar?: unknown }) {
  const c = data.company;
  const instrument = rentalInstrument(c);
  const minPrice = minRentalPrice(c);
  const phoneLabel = formatContactPhone(c.phone);
  const preselected = orderOfferFromQuery(c.offers, orderCar);

  return (
    <div style={{ background: 'var(--bg-primary)' }}>
      <Header overPhoto />

      <RentalHero name={c.name} photos={c.photos}>
        <nav aria-label="Хлебные крошки" className="flex items-center gap-1 text-[13px] mb-2 -ml-1">
          <Link href="/" className={CRUMB}>Главная</Link>
          <ChevronRight className="w-3 h-3 text-white/60" aria-hidden />
          <Link href="/car-rental" className={CRUMB}>Аренда автомобилей</Link>
        </nav>
        <PartnerLogo src={c.logo} name={c.name} size="hero" className="mb-3" />
        <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-white mb-2">Прокатчик · машины без водителя</p>
        <h1 className="font-playfair text-white font-bold leading-tight" style={{ fontSize: 'clamp(30px,5vw,52px)' }}>{c.name}</h1>
        {c.shortDescription && (
          <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-white/90">{c.shortDescription}</p>
        )}
        {instrument.length > 0 && (
          <dl className="mt-5 inline-flex flex-wrap rounded-2xl overflow-hidden backdrop-blur-md bg-black/40 border border-white/15" aria-label="Факты о прокатчике">
            {instrument.map((cell) => (
              <div key={cell.k} className="px-4 py-2.5">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-white/70">{cell.k}</dt>
                <dd className="text-[14px] font-semibold text-white mt-1">{cell.v}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-5">
          <a href={`#${RENTAL_REQUEST_ANCHOR}`} className="ds-btn ds-btn-primary inline-flex items-center gap-2" style={{ minHeight: 44 }}>
            <Send className="w-4 h-4" aria-hidden /> Заявка на машину
          </a>
        </div>
      </RentalHero>

      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 pt-6 pb-16">
          <div className="lg:col-span-8 space-y-12">

            {c.photos.length > 1 && (
              <section aria-label={`Фото: ${c.name}`}>
                <CharterPhotos name={c.name} photos={c.photos.slice(1)} />
              </section>
            )}

            <section aria-labelledby="rental-about">
              <H2 id="rental-about">О прокатчике</H2>
              {c.description ? (
                <p className="text-[var(--text-secondary)] leading-relaxed">{c.description}</p>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">Описание прокатчика на платформе не записано.</p>
              )}
            </section>

            <section aria-labelledby="rental-price">
              <H2 id="rental-price">Машины и цены</H2>
              <div className="ds-card px-5 py-3">
                <RentalOfferList offers={c.offers} orderSlug={c.slug} />
              </div>
            </section>

            <section aria-labelledby="rental-terms">
              <H2 id="rental-terms">Условия проката</H2>
              {c.terms ? (
                <>
                  <ul className="space-y-1.5 text-sm text-[var(--text-secondary)] list-disc pl-5">
                    {c.terms.items.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                  <p className="text-xs text-[var(--text-muted)] mt-2">
                    Словами прокатчика{c.terms.seenOn ? `, сверено ${c.terms.seenOn}` : ''}.
                  </p>
                </>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">Условия проката на платформе не записаны — уточняются у прокатчика.</p>
              )}
              {/* Всегда: чего прокатчик платформе не называл, страница не додумывает. */}
              <p className="text-sm text-[var(--text-secondary)] mt-3">
                {rentalUnknownsText()}. Оплата — напрямую ему: через Ведар машина не оплачивается.
              </p>
            </section>

            <section aria-labelledby="rental-who">
              <H2 id="rental-who">Прокатчик</H2>
              {/* Как «Кто проводит» на карточке тура (§11) и «Перевозчик» (§14):
                  вывеска, под ней — исполнитель по договору из legal_info. */}
              <div className="ds-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="w-14 h-14 rounded-full overflow-hidden shrink-0 relative bg-[var(--bg-hover)] flex items-center justify-center" aria-hidden>
                    {c.logo ? (
                      <Image src={c.logo} alt="" fill className="object-contain" sizes="56px" />
                    ) : c.photos[0] ? (
                      <Image src={photoSrc(c.photos[0].url, 320)} alt="" fill className="object-cover" sizes="56px" />
                    ) : (
                      <span className="font-playfair text-xl font-bold text-[var(--text-primary)]">{c.name.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-[10rem]">
                    <p className="font-playfair font-semibold text-[var(--text-primary)]">{c.name}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                      Исполнитель: {rentalRequisitesLine(c.legal) ?? 'реквизиты на платформе не записаны'}
                    </p>
                    {c.verified && (
                      <p className="text-[13px] text-[var(--success)] flex items-center gap-1.5 mt-1">
                        <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden /> Проверенный прокатчик
                      </p>
                    )}
                  </div>
                </div>
                {c.phone || c.telegramHref ? (
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
                  </div>
                ) : (
                  <p className="text-sm text-[var(--text-secondary)]">Контакты прокатчика не записаны — заявка дойдёт через менеджера Ведара.</p>
                )}
              </div>
            </section>

            {c.alsoCarrier && (
              <section aria-labelledby="rental-also-carrier">
                <H2 id="rental-also-carrier">Машина с водителем</H2>
                <Link href={carrierPagePath(c.slug)} className="ds-card p-5 flex items-start gap-3 hover:bg-[var(--bg-hover)] transition-colors duration-200">
                  <Bus className="w-5 h-5 text-[var(--ocean)] shrink-0 mt-0.5" aria-hidden />
                  <span className="text-sm text-[var(--text-primary)]">
                    Этот партнёр также возит целой машиной с водителем — прайс на странице перевозчика.
                  </span>
                </Link>
              </section>
            )}

            <section aria-labelledby="rental-kuzmich">
              <H2 id="rental-kuzmich">Спросить Кузьмича</H2>
              <p className="text-sm text-[var(--text-secondary)] mb-4">
                Куда доедет машина без водителя, какая обстановка на дорогах и что взять с собой. Кузьмич знает сводку по
                краю — спросите, например: «можно ли доехать до Горелого на внедорожнике в октябре».
              </p>
              <KuzmichActions primaryHref="/kuzmich" />
            </section>
          </div>

          <aside className="lg:col-span-4">
            <div className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
              <section id={RENTAL_REQUEST_ANCHOR} className="ds-card p-5 scroll-mt-24 lg:scroll-mt-20" aria-labelledby="rental-request-title">
                <h2 id="rental-request-title" className="font-playfair text-xl font-bold text-[var(--text-primary)]">Заявка на машину</h2>
                {minPrice !== null && (
                  <p className="text-sm text-[var(--text-secondary)] mt-1">
                    от <span className="font-semibold text-[var(--accent)]">{formatRub(minPrice)}</span> за сутки за машину по прайсу
                  </p>
                )}
                <div className="mt-4">
                  <RentalRequestForm
                    companySlug={c.slug}
                    companyName={c.name}
                    offers={c.offers.map((o) => ({ title: o.title, priceRubPerDay: o.priceRubPerDay, priceIsFrom: o.priceIsFrom }))}
                    initialOffer={preselected}
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
