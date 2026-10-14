import Link from 'next/link';
import { Bus, ClipboardList, MessageCircle, Phone, Send } from 'lucide-react';
import { LazyClip } from '@/components/media/LazyClip';
import { CharterPhotos } from '@/components/transfers/CharterPhotos';
import { formatContactPhone } from '@/lib/stay/contact-phone';
import { CharterPriceList } from '@/components/transfers/CharterPriceList';
import { carrierPagePath, charterOrderPath, charterRequisitesLine, describeFleet, type CharterCarrier } from '@/lib/transfers/charter-format';

/**
 * Перевозчик «под заказ»: парк, прайс на целую машину, связь, фото.
 *
 * Карточка в списке /transfers; полная страница перевозчика — /transfers/[slug]
 * (стандарт 13.10). Строки прайса у обоих — один компонент (CharterPriceList):
 * прайс, нарисованный двумя вёрстками, разошёлся бы в подписях. Данные —
 * только из lib/transfers/charter (миграция 1185); здесь ничего не считается.
 *
 * Цена называется «за машину»: «за место» не пишется нигде, потому что
 * перевозчик её не называл (§4.0). Номер телефона показан здесь и в ответы
 * Кузьмича и MCP не уходит (pd-guard) — им даётся ссылка на карточку.
 */
export function CharterCard({ carrier }: { carrier: CharterCarrier }) {
  const fleet = describeFleet(carrier.vehicles);
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
        <Link
          href={carrierPagePath(carrier.slug)}
          className="text-xs text-[var(--ocean)] underline shrink-0"
        >
          Карточка перевозчика
        </Link>
      </div>

      <CharterPriceList carrier={carrier} orderSlug={carrier.slug} />

      <p className="text-xs text-[var(--text-muted)]">
        Сколько дней в поездке и что входит в цену — в прайсе не указано, уточняйте у перевозчика при заказе. Расчёт —
        напрямую с ним: через платформу вахтовки под заказ не оплачиваются.
      </p>

      {/* Заявка — главное действие карточки (владелец 14.10: «это сложно
          получается»): до этого здесь была только кнопка звонка, а к форме вела
          мелкая ссылка «Карточка перевозчика». */}
      <Link
        href={charterOrderPath(carrier.slug)}
        className="ds-btn ds-btn-primary w-full sm:w-auto inline-flex items-center justify-center gap-2"
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

      {carrier.video && (
        <figure>
          {/* preload="none": ролик ~3 МБ, на мобильной сети он не должен
              качаться, пока человек не нажал «играть»; кадр-обложка — отдельный файл.
              Звука нет (решение владельца 09.10): дорожка вырезана из самого
              файла, muted — на случай, если ролик заменят файлом со звуком. */}
          <video
            controls
            muted
            playsInline
            preload="none"
            poster={carrier.video.poster}
            className="w-full rounded-lg bg-[var(--bg-hover)]"
            aria-label={`Видео: ${carrier.name}`}
          >
            <source src={carrier.video.url} type="video/mp4" />
          </video>
          {/* «Видео», а не «Видео целиком»: с 09.10 внизу другой ролик, а не
              полная версия клипов над ним (владелец: «видео дублируются»). */}
          <figcaption className="text-xs text-[var(--text-muted)] mt-1">Видео: {carrier.name}</figcaption>
        </figure>
      )}

      {carrier.photos.length > 0 && (
        // Подпись — под каждым снимком: автор назван не у всех, и одна общая
        // строка «Фото: Шатун» приписала бы чужие кадры перевозчику. Снимок
        // открывается на весь экран (CharterPhotos), а не сырым файлом.
        <CharterPhotos name={carrier.name} photos={carrier.photos} />
      )}
    </section>
  );
}
