import Image from 'next/image';
import { photoSrc } from '@/lib/images/variant';

/**
 * Снимок героя — полосы во всю ширину под заголовком: карточка тура (§11) и
 * страница перевозчика (§14). Владелец 14.10: «в дисктопе видео и фото
 * растягиваются нужно сделать нормально».
 *
 * Снимки у нас 900–1600 px по ширине, у операторов — портретные 960×1280, а
 * полоса на мониторе — 1920 px и шире: `object-cover` растягивал кадр в
 * полтора-два раза, и он мылился (замер 14.10: «Шатун» 1156 px — в 1,66 раза).
 *
 * Теперь резкий снимок не шире колонки страницы — 72rem, та же ширина, что у
 * текста поверх него. Поля справа и слева — тот же снимок, размытый: полоса
 * остаётся во всю ширину, у прозрачной шапки есть фон, а сам кадр не тянется.
 * Край резкого кадра растушёван в размытый. На экране уже колонки всё как
 * было: кадр во всю ширину, полей нет.
 *
 * Рисуется внутри позиционированного родителя (кнопка героя `absolute inset-0`).
 */
export function HeroPhoto({ src, alt, objectPosition, filter }: {
  src: string;
  alt: string;
  /** Точка кадрирования: у туров 50% 30% — «чтоб голову не обрезал» (23.08). */
  objectPosition: string;
  filter?: string;
}) {
  return (
    <>
      {/* Поля широкого экрана. Уже колонки их не видно — и не качается
          (display:none + lazy). Размытому кадру хватает нарезки 320. */}
      <Image
        src={photoSrc(src, 320)}
        alt=""
        aria-hidden
        fill
        sizes="100vw"
        loading="lazy"
        data-hero-backdrop=""
        className="hidden min-[1152px]:block object-cover scale-110 blur-2xl"
        style={{ objectPosition }}
      />
      <span
        data-hero-frame=""
        className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-full max-w-6xl min-[1152px]:[mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]"
      >
        <Image
          src={photoSrc(src, 1280)}
          alt={alt}
          fill
          priority
          sizes="(min-width: 1152px) 1152px, 100vw"
          className="object-cover"
          style={{ objectPosition, filter }}
        />
      </span>
    </>
  );
}
