'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  MapPin, Star, Clock, BedDouble, Users, ShieldCheck, Sparkles,
  ChevronLeft, Wifi, ExternalLink, Phone, Send, MessageCircle,
} from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { StayBookingForm } from '@/components/booking/StayBookingForm';
import { OperatorGallery } from '@/components/operator/OperatorGallery';
import { PhotoLightbox } from '@/components/shared/PhotoLightbox';
import { StayRequestForm } from '@/components/stay/StayRequestForm';
import { StayLocationMap, stayCoords } from '@/components/stay/StayLocationMap';
import { funnelBeacon } from '@/lib/funnel/beacon';
import { formatContactPhone, messengerLinks, type NumberMessenger } from '@/lib/stay/contact-phone';
import { ROOM_TYPE_LABELS, RoomType } from '@/lib/stay/room-types';
import { ACCOMMODATION_TYPE_LABELS, AccommodationType } from '@/lib/stay/accommodation-types';

/**
 * Публичная детальная страница объекта размещения — до неё карточки
 * листинга вели на несуществующий /hub/stay/[id] (404), а номера и
 * цены гость не видел вовсе. Данные: GET /api/accommodations/[id]
 * (номера, отзывы, похожие). Бронирование конкретного номера —
 * следующий шаг (форма с выбором номера).
 */

interface Room {
  id: string;
  name: string;
  roomType: string;
  description: string | null;
  sizeSqm: number | null;
  maxGuests: number;
  pricePerNight: number;
}

interface Review {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  user: { name: string | null };
  ownerReply?: string | null;
}

interface SimilarItem {
  id: string;
  name: string;
  type: string;
  address: string;
  /** null — цену не называли. */
  pricePerNight: number | null;
  /** null — объект никто не оценивал (§4.0), а не «нуль звёзд». */
  rating: number | null;
  image: string | null;
}

interface AccommodationDetail {
  id: string;
  name: string;
  type: string;
  description: string | null;
  address: string;
  /** {lat, lng} из accommodations.coordinates; не годятся — карты нет (StayLocationMap). */
  coordinates?: unknown;
  starRating: number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  /** from: null — цену не называли (объект с бронью на своём сайте). */
  pricePerNight: { from: number | null; to: number | null };
  amenities: string[];
  /** Бронь на сайте самого объекта (миграция 1109); null — нет. */
  externalBookingUrl: string | null;
  /** Телефон самого объекта (миграция 1179), «+7XXXXXXXXXX»; null — не записан. */
  contactPhone: string | null;
  /** На каких мессенджерах заведён этот номер (миграция 1181); [] — не записано. */
  contactMessengers: NumberMessenger[];
  /** Хозяин подключил MAX: заявка с формы придёт ему туда (lib/stay/accommodation-detail). */
  ownerOnMax: boolean;
  /** null — объект никто не оценивал (§4.0), а не «нуль звёзд». */
  rating: number | null;
  reviewCount: number;
  isVerified: boolean;
  images: { url: string; alt: string | null }[];
  rooms: Room[];
  reviews: Review[];
  similar: SimilarItem[];
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat('ru-RU').format(v);
}

function toHHMM(t: string | null): string | null {
  return t ? String(t).slice(0, 5) : null;
}

export default function AccommodationDetailClient({ accommodationId, initialData }: {
  accommodationId: string;
  /** Карточка с сервера (page.tsx). Нет — сервер не смог прочитать, клиент пробует сам. */
  initialData?: AccommodationDetail;
}) {
  const [data, setData] = useState<AccommodationDetail | null>(initialData ?? null);
  const [notFound, setNotFound] = useState(false);
  const [failed, setFailed] = useState(false);
  const [photo, setPhoto] = useState<number | null>(null);

  useEffect(() => {
    if (initialData) return;
    fetch(`/api/accommodations/${accommodationId}`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.ok ? r.json() : null;
      })
      .then((d: { success?: boolean; data?: AccommodationDetail } | null) => {
        if (d === null) return;
        if (d?.success && d.data) setData(d.data);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [accommodationId, initialData]);

  if (notFound) {
    return (
      <>
        <Header />
        <div className="ds-page pt-24 pb-10 text-center">
          <p className="text-[var(--text-secondary)] mb-4">Объект размещения не найден или снят с публикации</p>
          <Link href="/accommodations" className="ds-btn ds-btn-secondary">К каталогу жилья</Link>
        </div>
      </>
    );
  }

  if (failed) {
    return (
      <>
        <Header />
        <div className="ds-page pt-24 pb-10 text-center">
          <p className="text-[var(--danger)]">Не удалось загрузить объект. Обновите страницу.</p>
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <Header />
        <div className="ds-page pt-24 pb-10 space-y-4">
          <div className="ds-skeleton h-64 rounded-lg" />
          <div className="ds-skeleton h-8 w-2/3 rounded-lg" />
          <div className="ds-skeleton h-24 rounded-lg" />
        </div>
      </>
    );
  }

  const typeLabel = ACCOMMODATION_TYPE_LABELS[data.type as AccommodationType] ?? data.type;
  const checkIn = toHHMM(data.checkInTime);
  const checkOut = toHHMM(data.checkOutTime);
  // Бронь и цены ведёт сам объект: по своему сайту или по телефону, когда
  // своих номеров у нас нет. Тогда ни списка номеров, ни нашей формы, ни
  // фразы про «оператора платформы» (оплата платформой выключена 05.10).
  const viaOwner = Boolean(data.externalBookingUrl) || (Boolean(data.contactPhone) && data.rooms.length === 0);
  const phoneLabel = formatContactPhone(data.contactPhone);
  // Чаты по тому же номеру (1181). MAX здесь нет: ссылки по номеру в MAX не
  // существует, а профиль знает только его владелец (tests/unit/max-contact).
  const chats = messengerLinks(data.contactPhone, data.contactMessengers);

  return (
    <>
      <Header />
      <div className="ds-page pt-20 pb-12 max-w-4xl mx-auto">

        <Link href="/accommodations" className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors mb-4">
          <ChevronLeft className="w-3.5 h-3.5" /> Каталог жилья
        </Link>

        {/* Фото. До 10.10 карточка рисовала только первый снимок: у «Кутхи»
            девятнадцать из двадцати фото было не увидеть никак. Главный кадр
            открывается на весь экран, остальные — сеткой под ним; просмотрщик
            общий с карточкой тура и страницей оператора. */}
        {data.images.length > 0 && (
          <button
            type="button"
            onClick={() => setPhoto(0)}
            className="relative block w-full h-64 sm:h-80 rounded-lg overflow-hidden mb-3 bg-[var(--bg-hover)]"
            aria-label={`Открыть фото 1 из ${data.images.length}`}
          >
            <Image
              src={data.images[0].url}
              alt={data.images[0].alt ?? data.name}
              fill
              className="object-cover"
              sizes="(max-width: 896px) 100vw, 896px"
            />
          </button>
        )}
        {data.images.length > 1 && (
          <div className="mb-6">
            <OperatorGallery images={data.images.slice(1).map(i => i.url)} name={data.name} />
          </div>
        )}
        {data.images.length === 1 && <div className="mb-3" />}
        {photo !== null && (
          <PhotoLightbox
            images={data.images.map(i => i.url)}
            alt={data.name}
            startIdx={photo}
            captions={data.images.map(i => i.alt)}
            onClose={() => setPhoto(null)}
          />
        )}

        {/* Заголовок */}
        <div className="mb-6">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="ds-label">{typeLabel}</span>
            {data.isVerified ? (
              <span className="ds-badge text-[var(--success)] border border-[var(--border)] inline-flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" /> Проверено платформой
              </span>
            ) : (
              <span className="ds-badge text-[var(--warning)] border border-[var(--border)] inline-flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> Новый объект — проверка идёт
              </span>
            )}
          </div>
          <h1 className="ds-h1 mb-2">{data.name}</h1>
          <div className="flex items-center gap-4 flex-wrap text-sm text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5" /> {data.address}
            </span>
            {/* Оценка — только когда она есть. Прежде строка рисовалась по
                числу отзывов и звала .toFixed у рейтинга: с честным null
                (API отдаёт его, когда объект не оценивали) это уронило бы
                весь экран. */}
            {data.rating !== null && data.reviewCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <Star className="w-3.5 h-3.5 text-[var(--warning)]" />
                {data.rating.toFixed(1)} · {data.reviewCount} отзывов
              </span>
            )}
            {(checkIn || checkOut) && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {checkIn && `заезд с ${checkIn}`}{checkIn && checkOut && ' · '}{checkOut && `выезд до ${checkOut}`}
              </span>
            )}
          </div>
        </div>

        {/* Описание */}
        {data.description && (
          <p className="text-[var(--text-secondary)] leading-relaxed mb-6 whitespace-pre-line">
            {data.description}
          </p>
        )}

        {/* Удобства */}
        {data.amenities.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-8">
            {data.amenities.map(a => (
              <span key={a} className="ds-badge border border-[var(--border)] text-[var(--text-secondary)] inline-flex items-center gap-1">
                <Wifi className="w-3 h-3" /> {a}
              </span>
            ))}
          </div>
        )}

        {/* Где находится (владелец 10.10: «точка на карте есть?») — своя карта,
            чужих навигаторов нет. Координат нет или они негодные — блока нет. */}
        {(() => {
          const coords = stayCoords(data.coordinates);
          return coords ? (
            <section className="mb-8 space-y-2" aria-label="Где находится">
              <h2 className="ds-h2">Где находится</h2>
              <p className="text-sm text-[var(--text-secondary)] inline-flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" /> {data.address}
              </p>
              <StayLocationMap coords={coords} name={data.name} />
            </section>
          ) : null;
        })()}

        {/* Объект без своего сайта брони (миграция 1179, «Кутха»): цены и даты
            у владельца, связь — звонком. Номер уходит только сюда: в ответы
            Кузьмича и MCP он не попадает (pd-guard). Нажатие считается как
            спрос на жильё, в NSM не входит. */}
        {data.contactPhone && phoneLabel && (
          <div className="ds-card p-5 mb-8 space-y-3">
            {/* Цену владелец может назвать нам (1198, «Кутха»): тогда она есть
                в карточке, и фраза «цены — у владельца» ей бы противоречила. */}
            <p className="text-sm text-[var(--text-secondary)]">
              {data.pricePerNight.from != null ? 'Свободные даты и условия' : 'Цены, свободные даты и условия'} — у владельца объекта. Бронь и оплата идут напрямую с ним: платформа оплату не принимает.
            </p>
            <a
              href={`tel:${data.contactPhone}`}
              onClick={() => funnelBeacon('stay_phone_call', data.id)}
              className="ds-btn ds-btn-primary w-full sm:w-auto inline-flex items-center justify-center gap-2"
            >
              <Phone className="w-4 h-4" />
              Позвонить {phoneLabel}
            </a>
            {chats.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {chats.map(c => (
                  <a
                    key={c.kind}
                    href={c.href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    onClick={() => funnelBeacon('stay_message_click', data.id)}
                    className="ds-btn ds-btn-secondary inline-flex items-center justify-center gap-2"
                  >
                    {c.kind === 'telegram' ? <Send className="w-4 h-4" /> : <MessageCircle className="w-4 h-4" />}
                    Написать в {c.label}
                  </a>
                ))}
              </div>
            )}
            {/* Заявка хозяину одним сообщением в MAX (1206, 10.10) — у объекта
                без своей брони и без номеров; сервер проверяет то же условие. */}
            {!data.externalBookingUrl && data.rooms.length === 0 && (
              <div className="pt-3 border-t border-[var(--border)]">
                <StayRequestForm accommodationId={data.id} phoneLabel={phoneLabel} ownerOnMax={data.ownerOnMax} />
              </div>
            )}
          </div>
        )}

        {/* Бронь на сайте объекта (29.09): живые цены и свободные даты там,
            где объект их ведёт. Переход считается — это довод в решении,
            подключать ли поставщика (счётчик спроса, lib/stay/demand). */}
        {data.externalBookingUrl && (
          <div className="ds-card p-5 mb-8 space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">
              Номера, цены и свободные даты — на сайте объекта: там же бронь и оплата.
            </p>
            <a
              href={data.externalBookingUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              onClick={() => funnelBeacon('stay_external_booking', data.id)}
              className="ds-btn ds-btn-primary w-full sm:w-auto inline-flex items-center justify-center gap-2"
            >
              Забронировать на сайте отеля
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        )}

        {/* Номера. Есть ссылка на бронь на сайте объекта — она ЕДИНСТВЕННЫЙ путь
            брони: два пути («там же бронь и оплата» и форма ниже) противоречили
            бы друг другу, а цены в наших номерах и на сайте объекта могут
            расходиться (обзор 29.09). */}
        {!viaOwner && (
          <h2 className="ds-h2 mb-4">Номера и цены</h2>
        )}
        {viaOwner ? null : data.rooms.length === 0 ? (
          (
            <div className="ds-card p-6 mb-8 text-center">
              <p className="text-sm text-[var(--text-secondary)]">
                {data.pricePerNight.from != null
                  ? <>Владелец ещё не добавил номера — цена от {formatMoney(data.pricePerNight.from)} ₽/ночь, бронирование через оператора платформы.</>
                  : <>Владелец ещё не добавил номера и не назвал цену — бронирование через оператора платформы.</>}
              </p>
            </div>
          )
        ) : (
          <div className="space-y-3 mb-8">
            {data.rooms.map(room => (
              <div key={room.id} className="ds-card p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{room.name}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5 flex items-center gap-3 flex-wrap">
                    <span className="inline-flex items-center gap-1">
                      <BedDouble className="w-3 h-3" />
                      {ROOM_TYPE_LABELS[room.roomType as RoomType] ?? room.roomType}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="w-3 h-3" /> до {room.maxGuests} гостей
                    </span>
                    {room.sizeSqm != null && <span>{room.sizeSqm} м²</span>}
                  </p>
                  {room.description && (
                    <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">{room.description}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-base font-bold text-[var(--text-primary)]">{formatMoney(room.pricePerNight)} ₽</p>
                  <p className="text-[10px] text-[var(--text-muted)]">за ночь</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Бронирование */}
        {!data.externalBookingUrl && data.rooms.length > 0 && (
          <>
            <h2 className="ds-h2 mb-4">Забронировать</h2>
            <div className="mb-8">
              <StayBookingForm
                accommodationId={data.id}
                accommodationName={data.name}
                rooms={data.rooms.map(r => ({
                  id: r.id,
                  name: r.name,
                  roomType: r.roomType,
                  maxGuests: r.maxGuests,
                  pricePerNight: r.pricePerNight,
                }))}
              />
            </div>
          </>
        )}

        {/* Отзывы */}
        {data.reviews.length > 0 && (
          <>
            <h2 className="ds-h2 mb-4">Отзывы гостей</h2>
            <div className="space-y-3 mb-8">
              {data.reviews.map(review => (
                <div key={review.id} className="ds-card p-4">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      {review.user.name ?? 'Гость'}
                    </p>
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--warning)]">
                      <Star className="w-3 h-3" /> {review.rating}
                    </span>
                  </div>
                  {review.comment && (
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{review.comment}</p>
                  )}
                  {review.ownerReply && (
                    <div className="mt-2 border-l-2 border-[var(--ocean)] pl-3">
                      <p className="text-xs text-[var(--text-muted)]">Ответ хозяина</p>
                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{review.ownerReply}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Похожие */}
        {data.similar.length > 0 && (
          <>
            <h2 className="ds-h2 mb-4">Похожее жильё рядом</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {data.similar.map(item => (
                <Link key={item.id} href={`/accommodations/${item.id}`} className="ds-card p-4 block hover:border-[var(--accent)] transition-colors">
                  <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{item.name}</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{item.address}</p>
                  <p className="text-xs text-[var(--text-primary)] mt-1 font-medium">
                    {item.pricePerNight != null ? `от ${formatMoney(item.pricePerNight)} ₽/ночь` : 'цена у объекта'}
                  </p>
                </Link>
              ))}
            </div>
          </>
        )}

      </div>
    </>
  );
}
