'use client';

/**
 * «Исследовать» на главной — колода мест вместо ленты (12.11, «Swipe deck»
 * из каталога Motion по выбору владельца, написано заново).
 *
 * Верхняя карточка листается пальцем: влево — следующее место, вправо —
 * предыдущее; тап открывает карточку места. Те же шаги — кнопками «Назад» и
 * «Дальше» и стрелками клавиатуры: жест не единственный путь, и без него
 * колода целиком доступна читалке экрана и тому, кто попросил систему
 * уменьшить движение (тогда карточка не тянется и не летит, а сменяется).
 *
 * Колоду надо узнать с первого взгляда (владелец 12.11: «листается как
 * колода, но сразу не понятно»): справа из-под верхней карточки выглядывают
 * края двух следующих, над колодой — «Листайте карточки» и счётчик «1 из N»,
 * а когда колода впервые за сессию попадает на экран, верхняя карточка один
 * раз чуть отъезжает влево и возвращается — показывает жест. При «уменьшить
 * движение» подсказки-движения нет, остаются стопка, слова и кнопки.
 *
 * Отступы — встроенным стилем и `gap`, а не утилитами: на мобильной главной
 * общий сброс `.v7 *{margin:0;padding:0}` стоит после стилей сайта и съедает
 * `p-4`, `space-y-*` и отступы `ds-btn` — текст карточки прилипал к краям, а
 * кнопки выглядели подписями.
 *
 * Здесь только места — географические факты без цены и брони (§9). Снимок —
 * копия 640 px; места без снимка — честная заглушка, не чужой кадр. Порядок —
 * тот, что дал загрузчик главной: со снимком впереди.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { motion, useMotionValue, useTransform, animate, useReducedMotion, type PanInfo } from 'framer-motion';
import { ChevronLeft, ChevronRight, MapPin, MoveHorizontal } from 'lucide-react';
import { photoSrc } from '@/lib/images/variant';

export interface SwipePlace {
  id: string;
  title: string;
  typeLabel: string;
  description: string;
  imageUrl: string | null;
  urlSlug: string | null;
}

/** Сдвиг или скорость, после которых жест — «листнуть», а не «дрогнул палец». */
export const SWIPE_DISTANCE_PX = 90;
export const SWIPE_VELOCITY = 500;

export function swipeDirection(offsetX: number, velocityX: number): -1 | 0 | 1 {
  if (offsetX <= -SWIPE_DISTANCE_PX || velocityX <= -SWIPE_VELOCITY) return 1;
  if (offsetX >= SWIPE_DISTANCE_PX || velocityX >= SWIPE_VELOCITY) return -1;
  return 0;
}

/** Насколько выглядывает каждая следующая карточка справа, px. */
export const DECK_PEEK_PX = 10;
/** Подсказка жеста показывается один раз за сессию браузера. */
const NUDGE_KEY = 'vedar:place-deck-nudged';

function nudgeSeen(): boolean {
  try { return window.sessionStorage.getItem(NUDGE_KEY) === '1'; } catch { return false; }
}
function markNudgeSeen(): void {
  try { window.sessionStorage.setItem(NUDGE_KEY, '1'); } catch { /* приватный режим: подсказка просто повторится */ }
}

export function placeHref(p: Pick<SwipePlace, 'id' | 'urlSlug'>): string {
  return `/places/${p.urlSlug ?? p.id}`;
}

function Card({ place }: { place: SwipePlace }) {
  return (
    <>
      <div
        className="aspect-[4/3] bg-[var(--bg-hover)] bg-cover bg-center flex items-center justify-center"
        style={place.imageUrl ? { backgroundImage: `url('${photoSrc(place.imageUrl, 640)}')` } : undefined}
      >
        {!place.imageUrl && <MapPin className="w-8 h-8 text-[var(--text-muted)]" aria-hidden="true" />}
      </div>
      <div className="flex flex-col gap-1" style={{ padding: 16 }}>
        <span className="text-xs text-[var(--text-secondary)]">{place.typeLabel}</span>
        <p className="text-lg font-bold leading-snug text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-playfair)' }}>{place.title}</p>
        {place.description && <p className="text-sm text-[var(--text-secondary)] line-clamp-2">{place.description}</p>}
      </div>
    </>
  );
}

export function PlaceSwipeDeck({ places }: { places: SwipePlace[] }) {
  const reduce = useReducedMotion() === true;
  const [index, setIndex] = useState(0);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 0, 240], [-8, 0, 8]);
  // Палец только что тянул карточку — отпускание не должно открыть место.
  // Метка времени, а не флаг: после листания щелчка может не быть вовсе, и
  // залипший флаг съел бы следующий настоящий тап.
  const dragEndedAt = useRef(0);
  const busy = useRef(false);

  const n = places.length;
  const deckRef = useRef<HTMLDivElement>(null);

  // Подсказка жеста: один раз, когда колода впервые видна больше чем наполовину.
  useEffect(() => {
    const el = deckRef.current;
    if (!el || reduce || n < 2 || typeof IntersectionObserver === 'undefined' || nudgeSeen()) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || busy.current) return;
      io.disconnect();
      markNudgeSeen();
      busy.current = true;
      void animate(x, [0, -36, 0], { duration: 0.9, ease: 'easeInOut', delay: 0.3 }).then(() => { busy.current = false; });
    }, { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, [n, reduce, x]);

  const go = useCallback((dir: 1 | -1) => {
    if (n < 2 || busy.current) return;
    const step = () => setIndex((i) => (i + dir + n) % n);
    if (reduce) { step(); return; }
    busy.current = true;
    void animate(x, dir === 1 ? -420 : 420, { duration: 0.22, ease: 'easeIn' }).then(() => {
      step();
      x.set(0);
      busy.current = false;
    });
  }, [n, reduce, x]);

  const onDragEnd = useCallback((_e: unknown, info: PanInfo) => {
    dragEndedAt.current = Date.now();
    const dir = swipeDirection(info.offset.x, info.velocity.x);
    if (dir === 0) void animate(x, 0, { type: 'spring', stiffness: 420, damping: 32 });
    else go(dir);
  }, [go, x]);

  const onKey = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }, [go]);

  if (n === 0) return null;
  const top = places[index];
  const behind = [1, 2].filter((k) => k < n).map((k) => places[(index + k) % n]);

  return (
    <div
      ref={deckRef}
      role="group"
      aria-roledescription="колода карточек"
      aria-label="Места: листайте карточки"
      onKeyDown={onKey}
      data-place-deck
      className="flex flex-col gap-3"
    >
      {n > 1 && (
        <div className="flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-1.5">
            <MoveHorizontal className="w-4 h-4" aria-hidden="true" />Листайте карточки
          </span>
          <span aria-live="polite">{index + 1} из {n}</span>
        </div>
      )}
      {/* Справа — место под края следующих карточек: стопку видно сразу. */}
      <div className="relative" style={{ paddingRight: behind.length * DECK_PEEK_PX }}>
        {behind.slice().reverse().map((p, ri) => {
          const depth = behind.length - ri;
          return (
            <div
              key={p.id}
              aria-hidden="true"
              data-deck-peek={depth}
              className="absolute inset-y-0 left-0 rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-card)] transition-transform duration-200 motion-reduce:transition-none"
              style={{
                right: behind.length * DECK_PEEK_PX,
                transform: `translateX(${depth * DECK_PEEK_PX}px) scale(${1 - depth * 0.04})`,
                transformOrigin: 'right center',
                opacity: 1 - depth * 0.2,
              }}
            >
              <Card place={p} />
            </div>
          );
        })}
        <motion.div
          key={top.id}
          className="relative rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-card)] shadow-sm touch-pan-y"
          style={reduce ? undefined : { x, rotate }}
          drag={reduce || n < 2 ? false : 'x'}
          dragSnapToOrigin={false}
          dragElastic={0.7}
          dragMomentum={false}
          onDragEnd={onDragEnd}
        >
          <Link
            href={placeHref(top)}
            className="block"
            draggable={false}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              if (Date.now() - dragEndedAt.current < 350) e.preventDefault();
            }}
          >
            <Card place={top} />
          </Link>
        </motion.div>
      </div>
      {n > 1 && (
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => go(-1)} className="ds-btn ds-btn-secondary inline-flex items-center gap-1 min-h-[44px]" style={{ padding: '0 16px' }} aria-label="Предыдущее место">
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />Назад
          </button>
          <button type="button" onClick={() => go(1)} className="ds-btn ds-btn-secondary inline-flex items-center gap-1 min-h-[44px]" style={{ padding: '0 16px' }} aria-label="Следующее место">
            Дальше<ChevronRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
