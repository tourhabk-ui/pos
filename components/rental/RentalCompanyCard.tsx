import Image from 'next/image';
import Link from 'next/link';
import { Car, ClipboardList, Phone, Send } from 'lucide-react';
import { photoSrc } from '@/lib/images/variant';
import { formatContactPhone } from '@/lib/stay/contact-phone';
import { RentalOfferList } from '@/components/rental/RentalOfferList';
import { PartnerLogo } from '@/components/shared/PartnerLogo';
import { rentalOrderPath, rentalPagePath, rentalUnknownsText, type RentalCompany } from '@/lib/rental/rental-format';

/**
 * Прокатчик на витрине /car-rental: машины с ценой за сутки, связь, фото.
 *
 * Карточка в списке; полная страница — /car-rental/[slug]. Строки прайса у
 * обоих — один компонент (RentalOfferList): прайс, нарисованный двумя
 * вёрстками, разошёлся бы в подписях. Данные — только из lib/rental (схема
 * 1317); здесь ничего не считается.
 *
 * Тот же визуальный язык, что у карточки перевозчика (CharterCard): оболочка
 * rounded-2xl, фото 4:3 сверху, если оно есть, чип над заголовком. Фото у
 * прокатчика может не быть вовсе — тогда карточка начинается с текста.
 *
 * Цена называется «за сутки за машину»: «за место» и «за человека» здесь не
 * пишутся нигде (§4.0). Номер телефона показан здесь и в ответы Кузьмича и
 * MCP не уходит (pd-guard) — им даётся ссылка на страницу.
 */
export function RentalCompanyCard({ company }: { company: RentalCompany }) {
  const hero = company.photos[0];
  const phoneLabel = formatContactPhone(company.phone);
  const hasContacts = Boolean(company.phone || company.telegramHref);

  const chipStyle: React.CSSProperties = {
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
    borderColor: 'color-mix(in srgb, currentColor 28%, transparent)',
  };

  return (
    <section
      className="group relative flex flex-col rounded-2xl overflow-hidden bg-[var(--bg-card)] border border-[var(--border)] shadow-sm hover:shadow-xl transition-all duration-300"
      aria-label={`${company.name}: прокат автомобилей`}
    >
      {hero && (
        <div className="relative aspect-[4/3] overflow-hidden bg-[var(--bg-hover)]">
          <Image
            src={photoSrc(hero.url, 640)}
            alt={`${company.name}: фото машины`}
            fill
            sizes="(max-width: 768px) 100vw, 672px"
            className="object-cover group-hover:scale-[1.04] transition-transform duration-700 ease-out"
          />
          {hero.credit && (
            <span className="absolute bottom-2 left-2 z-[2] px-2 py-0.5 rounded-full text-[11px] leading-tight text-white backdrop-blur-md bg-black/40 border border-white/15">
              Фото: {hero.credit}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col flex-1 p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-2">
              <span className="inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold text-[var(--text-secondary)]" style={chipStyle}>
                Прокат · машина без водителя
              </span>
            </p>
            <div className="flex items-center gap-3">
              <PartnerLogo src={company.logo} name={company.name} size="card" />
              <h3 className="font-playfair text-xl font-bold text-[var(--text-primary)]">
                <Link href={rentalPagePath(company.slug)} className="hover:underline">{company.name}</Link>
              </h3>
            </div>
            {company.shortDescription && (
              <p className="text-sm text-[var(--text-secondary)] mt-1">{company.shortDescription}</p>
            )}
            <p className="text-xs text-[var(--text-secondary)] mt-1 inline-flex items-center gap-1.5">
              <Car className="w-3.5 h-3.5 text-[var(--ocean)]" aria-hidden />
              {company.offers.length === 1 ? '1 машина в прайсе' : `${company.offers.length} машин в прайсе`}
            </p>
          </div>
          <Link href={rentalPagePath(company.slug)} className="text-xs text-[var(--ocean)] underline shrink-0">
            Страница прокатчика
          </Link>
        </div>

        <RentalOfferList offers={company.offers} orderSlug={company.slug} compact />

        <p className="text-xs text-[var(--text-muted)]">
          {rentalUnknownsText()}. Расчёт — напрямую с ним: через платформу машина не оплачивается.
        </p>

        {/* Заявка — главное действие карточки, как у перевозчика (владелец 14.10). */}
        <Link
          href={rentalOrderPath(company.slug)}
          className="ds-btn ds-btn-primary px-4 inline-flex items-center justify-center gap-2 self-start"
        >
          <ClipboardList className="w-4 h-4" aria-hidden />
          Заявка на машину
        </Link>

        {hasContacts ? (
          <div className="flex flex-wrap gap-2">
            {company.phone && phoneLabel && (
              <a href={`tel:${company.phone}`} className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-2">
                <Phone className="w-4 h-4" aria-hidden />
                Позвонить {phoneLabel}
              </a>
            )}
            {company.telegramHref && (
              <a
                href={company.telegramHref}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" aria-hidden />
                Написать в Telegram
              </a>
            )}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">Контакты прокатчика пока не записаны — заявка дойдёт через менеджера Ведара.</p>
        )}
      </div>
    </section>
  );
}
