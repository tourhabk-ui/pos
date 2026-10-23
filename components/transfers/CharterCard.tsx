import Image from 'next/image';
import Link from 'next/link';
import { Bus, ClipboardList, MessageCircle, Phone, Send } from 'lucide-react';
import { LazyClip } from '@/components/media/LazyClip';
import { CharterPhotos } from '@/components/transfers/CharterPhotos';
import { PartnerLogo } from '@/components/shared/PartnerLogo';
import { formatContactPhone } from '@/lib/stay/contact-phone';
import { CharterPriceList } from '@/components/transfers/CharterPriceList';
import { photoSrc } from '@/lib/images/variant';
import { CarrierVideo } from '@/components/transfers/CarrierVideo';
import {
  carrierPagePath, charterOrderPath, charterRequisitesLine, describeFleet, priceUnknownsText, type CharterCarrier,
} from '@/lib/transfers/charter-format';

/**
 * Перевозчик «под заказ»: парк, прайс на целую машину, связь, фото.
 *
 * Карточка в списке /transfers; полная страница перевозчика — /transfers/[slug]
 * (стандарт 13.10). Строки прайса у обоих — один компонент (CharterPriceList):
 * прайс, нарисованный двумя вёрстками, разошёлся бы в подписях. Данные —
 * только из lib/transfers/charter (миграция 1185); здесь ничего не считается.
 *
 * Витринная карточка говорит тем же визуальным языком, что карточка тура
 * в каталоге (MarketplaceClient.TourCard): та же оболочка rounded-2xl,
 * главное фото 4:3 во всю ширину сверху, чип над заголовком, текст блоком
 * p-4 под фото. Отличие сущности сохранено внутри: у перевозчика не одна
 * цена, а весь прайс строками, поэтому сетки туров и «одной цены» здесь нет.
 *
 * Цена называется «за машину»: «за место» не пишется нигде, потому что
 * перевозчик её не называл (§4.0). Номер телефона показан здесь и в ответы
 * Кузьмича и MCP не уходит (pd-guard) — им даётся ссылка на карточку.
 */
export function CharterCard({ carrier }: { carrier: CharterCarrier }) {
  const hero = carrier.photos[0];
  const fleet = describeFleet(carrier.vehicles, carrier.seatClasses);
  const phoneLabel = formatContactPhone(carrier.phone);
  const hasContacts = Boolean(carrier.phone || carrier.telegramHref || carrier.whatsappHref);

  const chipStyle: React.CSSProperties = {
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
    borderColor: 'color-mix(in srgb, currentColor 28%, transparent)',
  };

  return (
    <section
      className="group relative flex flex-col rounded-2xl overflow-hidden bg-[var(--bg-card)] border border-[var(--border)] shadow-sm hover:shadow-xl transition-all duration-300"
      aria-label={`${carrier.name}: машина под заказ`}
    >
      {hero && (
        <div className="relative aspect-[4/3] overflow-hidden bg-[var(--bg-hover)]">
          <Image
            src={photoSrc(hero.url, 640)}
            alt={`${carrier.name}: фото машины`}
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
            <span className="inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold text-[var(--text-secondary)]" style={chipStyle}>Под заказ · целая машина</span>
          </p>
          <div className="flex items-center gap-3">
            <PartnerLogo src={carrier.logo} name={carrier.name} size="card" />
            <h3 className="font-playfair text-xl font-bold text-[var(--text-primary)]">{carrier.name}</h3>
          </div>
          {fleet && (
            <p className="text-xs text-[var(--text-secondary)] mt-1 inline-flex items-center gap-1.5">
              <Bus className="w-3.5 h-3.5 text-[var(--ocean)]" aria-hidden /> {fleet}
            </p>
          )}
        </div>
        <Link
          href={carrierPagePath(carrier.slug)}
          className="text-xs text-[var(--ocean)] underline shrink-0"
        >
          Карточка перевозчика
        </Link>
      </div>

      <CharterPriceList carrier={carrier} orderSlug={carrier.slug} />

      <p className="text-xs text-[var(--text-muted)]">
        {priceUnknownsText(carrier)} — в прайсе не указано, уточняйте у перевозчика при заказе. Расчёт —
        напрямую с ним: через платформу машина под заказ не оплачивается.
      </p>

      {/* Заявка — главное действие карточки (владелец 14.10: «это сложно
          получается»): до этого здесь была только кнопка звонка, а к форме вела
          мелкая ссылка «Карточка перевозчика». */}
      <Link
        href={charterOrderPath(carrier.slug)}
        className="ds-btn ds-btn-primary px-4 inline-flex items-center justify-center gap-2 self-start"
      >
        <ClipboardList className="w-4 h-4" aria-hidden />
        Заявка на машину
      </Link>

      {/* Исполнитель — как на карточке тура: из записанного в legal_info; нет —
          так и сказано, не спрятано. */}
      <p className="text-xs text-[var(--text-secondary)]">
        Исполнитель: {charterRequisitesLine(carrier.legal) ?? 'реквизиты перевозчика не записаны на платформе'}.
      </p>

      {hasContacts ? (
        <div className="flex flex-wrap gap-2">
          {carrier.phone && phoneLabel && (
            <a
              href={`tel:${carrier.phone}`}
              className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-2"
            >
              <Phone className="w-4 h-4" aria-hidden />
              Позвонить {phoneLabel}
            </a>
          )}
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
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">Контакты перевозчика пока не записаны.</p>
      )}

      {/* Короткие петли «красота и движ»: ленивый показ (LazyClip) — файл не
          качается, пока клип не подошёл к экрану; играет без звука и только пока
          виден. Видео не обязано быть на каждой карточке: нет клипов — нет полосы. */}
      {carrier.clips.length > 0 && (
        <div>
          <ul className="flex gap-2 overflow-x-auto pb-2 snap-x" aria-label={`Короткие видео: ${carrier.name}`}>
            {carrier.clips.map((c) => (
              <li key={c.url} className="snap-start shrink-0 w-64">
                <LazyClip url={c.url} poster={c.poster} label={c.label} className="aspect-video" />
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-muted)]">Видео: {carrier.name}</p>
        </div>
      )}

      {/* Плеер — один на витрину и страницу перевозчика (CarrierVideo): рамка
          16:9 не шире своего ролика, без звука, без предзагрузки. */}
      {carrier.video && <CarrierVideo video={carrier.video} name={carrier.name} />}

      {carrier.photos.length > 1 && (
        // Первое фото уже стоит главным сверху (как фото тура) — в ленте
        // остаются остальные, чтобы один кадр не повторялся дважды в карточке.
        // Подпись — под каждым снимком: автор назван не у всех, и одна общая
        // строка «Фото: Шатун» приписала бы чужие кадры перевозчику. Снимок
        // открывается на весь экран (CharterPhotos), а не сырым файлом.
        <CharterPhotos name={carrier.name} photos={carrier.photos.slice(1)} />
      )}
      </div>
    </section>
  );
}
