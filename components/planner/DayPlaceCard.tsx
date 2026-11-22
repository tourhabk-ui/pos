'use client';
/**
 * Карточка места или маршрута у дня плана (lib/planner/day-place-cards):
 * миниатюра 64×64 (lazy, кадр не растягивается — object-cover в квадрате),
 * название, 1–2 строки, подпись автора кадра, ссылка на страницу места на
 * Ведаре. Открывается в новой вкладке: план не хранится в адресе, и уход со
 * страницы стоил бы плана. Кадра с автором нет — карточка без фото.
 */
import { useState } from 'react';
import { ExternalLink, MapPin, Route } from 'lucide-react';
import type { DayPlaceCard as Card } from '@/lib/planner/day-place-cards';

export const THUMB_PX = 64;

export function DayPlaceCard({ card }: { card: Card }) {
  const [broken, setBroken] = useState(false);
  const photo = card.photo && !broken ? card.photo : null;
  const Icon = card.kind === 'route' ? Route : MapPin;
  return (
    <a
      href={card.href}
      target="_blank"
      rel="noopener"
      data-day-place-card={card.kind}
      onClick={(e) => e.stopPropagation()}
      className="mx-3 mb-2 flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-2 hover:border-[var(--accent)]/60 transition-colors"
    >
      {photo ? (
        <span className="shrink-0 flex flex-col items-center gap-0.5" style={{ width: THUMB_PX }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- свой адрес /api/images, размер задан */}
          <img
            src={photo.src}
            alt={card.title}
            width={THUMB_PX}
            height={THUMB_PX}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="block rounded-md object-cover bg-[var(--bg-card)]"
            style={{ width: THUMB_PX, height: THUMB_PX }}
          />
          <span className="block w-full line-clamp-2 break-words text-center text-[9px] leading-tight text-[var(--text-muted)]" title={`Фото: ${photo.author}`}>
            Фото: {photo.author}
          </span>
        </span>
      ) : (
        <span aria-hidden className="shrink-0 flex items-center justify-center rounded-md bg-[var(--bg-card)] text-[var(--text-muted)]" style={{ width: 36, height: 36 }}>
          <Icon className="w-4 h-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-[var(--text-muted)]">{card.kind === 'route' ? 'Маршрут' : 'Место'}</span>
        <span className="block text-[13px] font-semibold leading-snug text-[var(--text-primary)] truncate">{card.title}</span>
        {card.text && <span className="block text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-2">{card.text}</span>}
        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)]">
          {card.kind === 'route' ? 'Страница маршрута' : 'Страница места'} на vedarai.ru
          <ExternalLink className="w-3 h-3" aria-hidden />
        </span>
      </span>
    </a>
  );
}
