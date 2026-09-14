'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Images } from 'lucide-react';
import { useState, useRef } from 'react';
import { LOCATION_TYPE_LABELS } from './types';
import { RouteGradientPlaceholder } from '@/components/routes/RouteGradientPlaceholder';

interface Props {
  placeId: string;
  name: string;
  locationType: string | null;
  lat: number;
  lng: number;
  photoUrl: string | null;
  photoCount: number;
  images?: string[];
  /**
   * Факты первого экрана: район, сложность, высота — что известно, то и
   * показываем, максимум три.
   *
   * Заведены 14.09. До этого под фотографией шли ЧЕТЫРЕ кнопки навигации
   * подряд («Навигация», автопуть, пеший путь, GPX) и ни одного факта о
   * самом месте: первый экран телефона предлагал уехать раньше, чем
   * рассказывал, куда человек попал. Показатели при этом в данных были —
   * они лежали ниже, за описанием, куда доходит не всякий.
   *
   * Пустые значения сюда не попадают по построению: список собирает
   * карточка, и «не знаем» — это отсутствие строки, а не прочерк (§4.0).
   */
  facts?: Array<{ label: string; value: string }>;
}

export default function PlaceHero({ placeId, name, locationType, lat, lng, photoUrl, photoCount, images, facts }: Props) {
  const [copied, setCopied] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const label = LOCATION_TYPE_LABELS[locationType ?? 'other'] ?? 'Место';
  const imgSrc = photoUrl ?? (photoCount > 0 ? `/api/images/route/${placeId}` : null);
  const coordStr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  // Build gallery: prefer images[] if multiple, else single imgSrc
  const gallery = images && images.length > 1
    ? images.filter(s => typeof s === 'string' && s.length > 0)
    : (imgSrc ? [imgSrc] : []);
  const isGallery = gallery.length > 1;

  function copyCoords() {
    navigator.clipboard?.writeText(coordStr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleScroll() {
    if (!scrollRef.current) return;
    const idx = Math.round(scrollRef.current.scrollLeft / scrollRef.current.clientWidth);
    setCurrentIdx(idx);
  }

  return (
    <div className="relative w-full overflow-hidden bg-[var(--bg-hover)]" style={{ height: 'clamp(320px, 62vh, 560px)' }}>

      {/* Photo / Gallery */}
      {isGallery ? (
        <div
          ref={scrollRef}
          className="flex h-full overflow-x-auto snap-x snap-mandatory"
          style={{ scrollbarWidth: 'none' }}
          onScroll={handleScroll}
        >
          {gallery.map((src, i) => (
            <div key={i} className="flex-shrink-0 w-full snap-start relative h-full">
              <Image src={src} alt={`${name} ${i + 1}`} fill className="object-cover" priority={i === 0} sizes="100vw" />
            </div>
          ))}
        </div>
      ) : gallery.length === 1 ? (
        <Image src={gallery[0]} alt={name} fill className="object-cover" priority sizes="100vw" />
      ) : (
        <RouteGradientPlaceholder title={name} locationType={locationType} className="w-full h-full" showLabel={false} />
      )}

      {/*
        Подложка под текст. Раньше это был один линейный градиент на всю
        высоту (from-black/80 via-black/20) — и на кадре, где низ уже тёмный и
        ПЛОСКИЙ (бетон, стена, вода в тени), он не делал ничего: заголовок
        читался как наклеенный на серый прямоугольник.

        Теперь два слоя: мягкое затемнение всего кадра и отдельная плотная
        подложка нижней трети с нелинейной кривой. Текст всегда лежит на
        своём фоне, а не на удачном месте фотографии.
      */}
      <div className="absolute inset-0 bg-black/15 pointer-events-none" />
      <div
        className="absolute inset-x-0 bottom-0 h-2/3 pointer-events-none"
        style={{
          background:
            'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.72) 28%, rgba(0,0,0,0.35) 62%, rgba(0,0,0,0) 100%)',
        }}
      />

      {/* Dot indicators for gallery */}
      {isGallery && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-1.5 z-20">
          {gallery.map((_, i) => (
            <div key={i} className={`rounded-full transition-all duration-200 ${
              i === currentIdx ? 'w-4 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/40'
            }`} />
          ))}
        </div>
      )}

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 pt-20 pb-4 z-20">
        <Link
          href="/routes?kind=place"
          className="inline-flex items-center gap-1.5 text-sm text-white/90 bg-black/50 px-3 py-1.5 rounded-full border border-white/15 hover:bg-black/70 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Все места
        </Link>

        <div className="flex items-center gap-2">
          {/* Координаты — прибор, а не заголовок. До 14.09 они стояли
              моноширинным шрифтом прямо под именем места, между названием и
              фактами: строка вида «53.28836, 158.35007» читается как вывод
              отладки и первое, что видел турист. Тому, кому они нужны в поле,
              они нужны в буфере обмена, а не в вёрстке — отсюда кнопка. */}
          <button
            onClick={copyCoords}
            aria-label={`Скопировать координаты: ${coordStr}`}
            className="inline-flex items-center gap-1.5 text-xs text-white/80 bg-black/40 px-2.5 py-1.5 rounded-full border border-white/15 hover:bg-black/60 transition-colors"
          >
            {copied
              ? <><Check className="w-3.5 h-3.5 text-[var(--success)]" /> Скопировано</>
              : <><Copy className="w-3.5 h-3.5" /> {lat.toFixed(3)}, {lng.toFixed(3)}</>
            }
          </button>

          {(isGallery ? gallery.length : photoCount) > 1 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-white/80 bg-black/40 px-2.5 py-1.5 rounded-full border border-white/15">
              <Images className="w-3.5 h-3.5" />
              {isGallery ? `${currentIdx + 1}/${gallery.length}` : photoCount}
            </span>
          )}
        </div>
      </div>

      {/* Bottom overlay: type + name + coords */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-5 z-10 pointer-events-none lg:px-6">
        {/* Ширина та же, что у сетки карточки ниже (_PlaceDetailClient):
            иначе на широком экране имя места висит по центру, а текст под ним
            начинается левее — разъезд, который читается как небрежность. */}
        <div className="max-w-3xl lg:max-w-6xl mx-auto">
          {/* Род места — надзаголовок, а не оранжевая плашка.
              Плашка спорила по яркости с кнопкой «Навигация» в двухстах
              пикселях ниже: акцент, употреблённый дважды подряд, перестаёт
              быть акцентом. Типографика справляется тут лучше цвета. */}
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">
            {label}
          </p>

          <h1
            className="text-[2.1rem] leading-[1.05] sm:text-5xl md:text-6xl font-bold text-white"
            style={{ fontFamily: 'var(--font-playfair)', textShadow: '0 2px 24px rgba(0,0,0,0.45)' }}
          >
            {name}
          </h1>

          {/* Факты первого экрана — строкой, через тонкие разделители.
              Пузырьки-«стекляшки» на фото складывались в нашлёпки; здесь
              работает та же типографика, что и в заголовке. */}
          {facts && facts.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              {facts.slice(0, 3).map((f) => (
                <span key={f.label} className="flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-white/50">{f.label}</span>
                  <span className="text-sm font-semibold text-white/95">{f.value}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
