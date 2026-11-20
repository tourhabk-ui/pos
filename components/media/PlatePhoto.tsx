'use client';

/**
 * Снимок плитки главной (туры, трансферы, жильё) — с запасным путём.
 *
 * Повод (13.11, владелец с телефона, «фото не подгружаеться»): в «Турах сезона»
 * у «Зимней рыбалки: ноябрь — январь» стояла тёмная пустая рамка, хотя снимок
 * цел — тот же адрес через несколько минут отдавался 200. Плитка рисовала
 * снимок фоном (`background-image`), а у фона нет ни второго шанса, ни события
 * ошибки: не дошёл один ответ (мобильная сеть, VPN, хранилище не ответило за
 * отведённое серверу время) — и рамка пустая до перезагрузки страницы, без
 * знака, что тут должна быть фотография.
 *
 * Теперь: сначала копия под рамку 4:3, если она есть (20.11), потом
 * уменьшенная копия 640 (`photoSrc`); не загрузилась — следующий адрес другим
 * запросом; не загрузился и исходный снимок — заглушка-градиент,
 * та же, что у плитки без снимка (`fallback`). Точка кадра — как у фона:
 * записанная (`photoFocusY`) или верх кадра, чтобы голова рыбака была цела.
 *
 * Ошибка, случившаяся до гидратации, React не доходит (`onError` вешается
 * позже), поэтому после монтирования снимок сверяется сам: загрузка кончилась,
 * а ширины нет — это отказ.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { photoSrc } from '@/lib/images/variant';
import { platePhotoSrc } from '@/lib/images/plate-photo';
import { photoFocusY } from '@/lib/tours/photo-focus';

interface Props {
  /** Адрес снимка из базы (исходник). */
  src: string;
  /** Что показать, если не загрузилось ничего. */
  fallback: ReactNode;
  className?: string;
}

/**
 * Адреса по очереди: копия под рамку 4:3 (20.11, #3564 п.1 — вертикальный
 * кадр без строк, которые рамка всё равно срежет), копия 640, исходник.
 * Повторов нет: чего у снимка нет, того в цепочке нет.
 */
export function platePhotoChain(src: string): string[] {
  const chain = [platePhotoSrc(src), photoSrc(src, 640), src].filter((u): u is string => Boolean(u));
  return [...new Set(chain)];
}

export function PlatePhoto({ src, fallback, className = 'plate-photo' }: Props) {
  const chain = platePhotoChain(src);
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLImageElement>(null);
  const current = chain[step];

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setStep((s) => s + 1);
  }, [current]);

  if (!current) return <>{fallback}</>;

  const y = photoFocusY(src);
  return (
    <img
      ref={ref}
      key={current}
      className={className}
      src={current}
      alt=""
      decoding="async"
      draggable={false}
      style={{ objectPosition: `50% ${y ?? 0}%` }}
      onError={() => setStep((s) => s + 1)}
    />
  );
}
