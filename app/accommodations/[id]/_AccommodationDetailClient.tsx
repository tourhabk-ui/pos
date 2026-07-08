'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  MapPin, Star, Clock, BedDouble, Users, ShieldCheck, Sparkles,
  ChevronLeft, Wifi,
} from 'lucide-react';
import { Header } from '@/components/layout/Header';
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
}

interface SimilarItem {
  id: string;
  name: string;
  type: string;
  address: string;
  pricePerNight: number;
  rating: number;
  image: string | null;
}

interface AccommodationDetail {
  id: string;
  name: string;
  type: string;
  description: string | null;
  address: string;
  starRating: number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  pricePerNight: { from: number; to: number | null };
  amenities: string[];
  rating: number;
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

export default function AccommodationDetailClient({ accommodationId }: { accommodationId: string }) {
  const [data, setData] = useState<AccommodationDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
  }, [accommodationId]);

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

  return (
    <>
      <Header />
      <div className="ds-page pt-20 pb-12 max-w-4xl mx-auto">

        <Link href="/accommodations" className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors mb-4">
          <ChevronLeft className="w-3.5 h-3.5" /> Каталог жилья
        </Link>

        {/* Фото */}
        {data.images.length > 0 && (
          <div className="relative w-full h-64 sm:h-80 rounded-lg overflow-hidden mb-6 bg-[var(--bg-hover)]">
            <Image
              src={data.images[0].url}
              alt={data.images[0].alt ?? data.name}
              fill
              className="object-cover"
              sizes="(max-width: 896px) 100vw, 896px"
            />
          </div>
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
            {data.reviewCount > 0 && (
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

        {/* Номера */}
        <h2 className="ds-h2 mb-4">Номера и цены</h2>
        {data.rooms.length === 0 ? (
          <div className="ds-card p-6 mb-8 text-center">
            <p className="text-sm text-[var(--text-secondary)]">
              Владелец ещё не добавил номера — цена от {formatMoney(data.pricePerNight.from)} ₽/ночь, бронирование через оператора платформы.
            </p>
          </div>
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
                    от {formatMoney(item.pricePerNight)} ₽/ночь
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
