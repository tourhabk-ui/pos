import Image from 'next/image';
import { photoSrc, photoSrcSet } from '@/lib/images/variant';

/**
 * Снимок героя — полосы во всю ширину под заголовком: карточка тура (§11),
 * страница перевозчика (§14), карточка места и маршрут. Владелец 14.10:
 * «в дисктопе видео и фото растягиваются нужно сделать нормально».
 * Владелец 21.11: «просто фото на турах местах и маршрутах растягиваются
 * по ширине».
 *
 * Снимки у нас 900–1600 px по ширине, у операторов — портретные 960×1280, а
 * полоса на мониторе — 1920 px и шире: `object-cover` растягивал кадр в
 * полтора-два раза, и он мылился (замер 14.10: «Шатун» 1156 px — в 1,66 раза).
 * Замер 21.11 на 1280: место — cover во всю ширину (1280×496 при исходнике
 * 1280×720; на 1920 уже апскейл), маршрут — `sizes=100vw` в полной полосе,
 * тур — резкий кадр в рамке 72rem, но рамка росла вместе с длинным
 * заголовком до 751 px в высоту.
 *
 * На широком экране (от 1024 px) резкий снимок вписан в рамку не шире
 * колонки страницы — 72rem — и не выше 32rem: портретный кадр не теряет
 * голову, ландшафт не тянется на весь монитор. Всё вокруг — тот же снимок,
 * размытый. На телефоне и планшете всё как было у каждого типа страницы:
 * туры и места — кадр во всю ширину с обрезкой, маршрут — вписан целиком
 * (`fitMobile="contain"`).
 *
 * Next Image у нас unoptimized (без sharp), поэтому srcset/sizes задаём
 * сами из нарезанных вариантов, когда они есть; иначе — один адрес.
 *
 * Рисуется внутри позиционированного родителя (кнопка героя `absolute inset-0`).
 */
export function HeroPhoto({ src, alt, objectPosition, filter, onError, priority = true, fitMobile = 'cover' }: {
  src: string;
  alt: string;
  /** Точка кадрирования: у туров 50% 30% — «чтоб голову не обрезал» (23.08). */
  objectPosition: string;
  filter?: string;
  onError?: () => void;
  /** Галерея места: высокий приоритет только у первого кадра. */
  priority?: boolean;
  /** На телефоне: туры и места — cover; маршрут уже был contain. */
  fitMobile?: 'cover' | 'contain';
}) {
  const sharpSrc = photoSrc(src, 1280);
  const srcSet = photoSrcSet(src);
  const fitClass = fitMobile === 'contain' ? 'object-contain' : 'object-cover lg:object-contain';

  return (
    // Резкий кадр (LCP, priority) идёт в разметке первым, размытый фон — за
    // ним, а слой задаёт z-index внутри изолированной обёртки. Прежде первым
    // <img> страницы был фон с loading="lazy", и проверки LCP (seomator 20.11)
    // принимали за героя его. Фон остаётся lazy: на телефоне он не качается.
    <span data-hero-photo="" className="absolute inset-0 isolate">
      <span
        data-hero-frame=""
        className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-full max-w-6xl z-[1] lg:inset-y-auto lg:top-1/2 lg:h-full lg:max-h-[32rem] lg:-translate-y-1/2 lg:[mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]"
      >
        {/* next/image при unoptimized не строит srcset — обычный img,
            чтобы браузер брал 320/640/1280 по sizes, а не тянул один адрес. */}
        <img
          src={sharpSrc}
          alt={alt}
          sizes="(min-width: 1152px) 1152px, 100vw"
          {...(srcSet ? { srcSet } : {})}
          className={`absolute inset-0 h-full w-full ${fitClass}`}
          style={{ objectPosition, filter }}
          fetchPriority={priority ? 'high' : undefined}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          onError={onError}
        />
      </span>
      {/* Фон широкого экрана. На телефоне его не видно — и не качается
          (display:none + lazy). Размытому кадру хватает нарезки 320. */}
      <Image
        src={photoSrc(src, 320)}
        alt=""
        aria-hidden
        fill
        sizes="100vw"
        loading="lazy"
        data-hero-backdrop=""
        className="hidden lg:block object-cover scale-110 blur-2xl"
        style={{ objectPosition }}
      />
    </span>
  );
}
