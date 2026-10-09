import Image from 'next/image';
import Link from 'next/link';
import { Bus, MessageCircle, Phone, Send } from 'lucide-react';
import { photoSrc } from '@/lib/images/variant';
import { formatContactPhone } from '@/lib/stay/contact-phone';
import { charterFootnote, describeFleet, formatRub, type CharterCarrier } from '@/lib/transfers/charter-format';

/**
 * Перевозчик «под заказ»: парк, прайс на целую машину, связь, фото.
 *
 * Один компонент на два экрана — /transfers и карточку /operators/[slug]:
 * прайс, нарисованный двумя вёрстками, разошёлся бы в подписях. Данные —
 * только из lib/transfers/charter (миграция 1185); здесь ничего не считается.
 *
 * Цена называется «за машину»: «за место» не пишется нигде, потому что
 * перевозчик её не называл (§4.0). Номер телефона показан здесь и в ответы
 * Кузьмича и MCP не уходит (pd-guard) — им даётся ссылка на карточку.
 */
export function CharterCard({
  carrier,
  linkToProfile = true,
  showPhotos = true,
}: {
  carrier: CharterCarrier;
  /** На странице самого перевозчика ссылка на неё же не нужна. */
  linkToProfile?: boolean;
  /** Там же галерею рисует сама страница — вторая лента повторяла бы её. Видео это не касается: у страницы его места нет. */
  showPhotos?: boolean;
}) {
  const fleet = describeFleet(carrier.vehicles);
  const footnote = charterFootnote(carrier);
  const phoneLabel = formatContactPhone(carrier.phone);
  const hasContacts = Boolean(carrier.phone || carrier.telegramHref || carrier.whatsappHref);

  return (
    <section className="ds-card p-5 space-y-4" aria-label={`${carrier.name}: вахтовки под заказ`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="ds-label mb-1">Под заказ · целая машина</p>
          <h3 className="font-playfair text-xl font-bold text-[var(--text-primary)]">{carrier.name}</h3>
          {fleet && (
            <p className="text-xs text-[var(--text-secondary)] mt-1 inline-flex items-center gap-1.5">
              <Bus className="w-3.5 h-3.5 text-[var(--ocean)]" aria-hidden /> {fleet}
            </p>
          )}
        </div>
        {linkToProfile && (
          <Link
            href={`/operators/${carrier.slug}`}
            className="text-xs text-[var(--ocean)] underline shrink-0"
          >
            Карточка перевозчика
          </Link>
        )}
      </div>

      <dl>
        {carrier.destinations.map((d) => (
          <div
            key={`${d.from}/${d.to}`}
            className="flex items-baseline justify-between gap-3 py-2 border-b border-[var(--border)]"
          >
            <dt className="text-sm text-[var(--text-primary)]">{d.to}</dt>
            <dd className="text-right">
              <span className="text-sm font-semibold text-[var(--accent)]">{formatRub(d.priceRub)}</span>
              {d.note && <span className="block text-xs text-[var(--text-muted)]">{d.note}</span>}
            </dd>
          </div>
        ))}
        {carrier.extraDay && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-sm text-[var(--text-primary)]">Доплата за день</dt>
            <dd className="text-right">
              <span className="text-sm font-semibold text-[var(--accent)]">+{formatRub(carrier.extraDay.priceRub)} в день</span>
              {carrier.extraDay.note && (
                <span className="block text-xs text-[var(--text-muted)]">{carrier.extraDay.note}</span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <p className="text-xs text-[var(--text-muted)]">
        Цена — за машину целиком, не за место.{footnote ? ` ${footnote}` : ''} Сколько дней в поездке и что входит
        в цену — в прайсе не указано, уточняйте у перевозчика при заказе. Заказ и расчёт — напрямую с ним: через платформу
        вахтовки под заказ не оплачиваются.
      </p>

      {hasContacts ? (
        <div className="space-y-2">
          {carrier.phone && phoneLabel && (
            <a
              href={`tel:${carrier.phone}`}
              className="ds-btn ds-btn-primary w-full sm:w-auto inline-flex items-center justify-center gap-2"
            >
              <Phone className="w-4 h-4" aria-hidden />
              Позвонить {phoneLabel}
            </a>
          )}
          {(carrier.telegramHref || carrier.whatsappHref) && (
            <div className="flex flex-wrap gap-2">
              {carrier.telegramHref && (
                <a
                  href={carrier.telegramHref}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-2"
                >
                  <Send className="w-4 h-4" aria-hidden />
                  Написать в Telegram
                </a>
              )}
              {carrier.whatsappHref && (
                <a
                  href={carrier.whatsappHref}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-2"
                >
                  <MessageCircle className="w-4 h-4" aria-hidden />
                  Написать в WhatsApp
                </a>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">Контакты перевозчика пока не записаны.</p>
      )}

      {carrier.video && (
        <figure>
          {/* preload="none": ролик ~3 МБ, на мобильной сети он не должен
              качаться, пока человек не нажал «играть»; кадр-обложка — отдельный файл. */}
          <video
            controls
            playsInline
            preload="none"
            poster={carrier.video.poster}
            className="w-full rounded-lg bg-[var(--bg-hover)]"
            aria-label={`Видео: ${carrier.name}`}
          >
            <source src={carrier.video.url} type="video/mp4" />
          </video>
          <figcaption className="text-xs text-[var(--text-muted)] mt-1">Видео: {carrier.name}</figcaption>
        </figure>
      )}

      {showPhotos && carrier.photos.length > 0 && (
        <div>
          <ul className="flex gap-2 overflow-x-auto pb-2 snap-x" aria-label={`Фото: ${carrier.name}`}>
            {carrier.photos.map((url, i) => (
              <li key={url} className="snap-start shrink-0">
                <a href={url} target="_blank" rel="noopener noreferrer" className="block relative w-40 h-28 rounded-lg overflow-hidden bg-[var(--bg-hover)]">
                  <Image
                    src={photoSrc(url, 320)}
                    alt={`${carrier.name}: фото ${i + 1}`}
                    fill
                    className="object-cover"
                    sizes="160px"
                    loading="lazy"
                  />
                </a>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-muted)]">Фото: {carrier.name}</p>
        </div>
      )}
    </section>
  );
}
