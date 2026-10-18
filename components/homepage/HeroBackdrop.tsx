import { photoSrc, photoSrcSet } from '@/lib/images/variant';

/**
 * Фото героя главной — элемент LCP мобильной главной.
 *
 * До 14.10 фото стояло фоном из CSS: браузер находил его только после разбора
 * стилей, а качал JPEG целиком — 165 КБ на любом экране. Прогон 9 переписи
 * (Lighthouse, мобильный профиль): LCP 4,5 с, из них задержка загрузки 1,4 с и
 * сама загрузка 2,0 с. Теперь это <img> из нарезанных WebP (`npm run images`
 * режет герою и родную ширину, 1024): телефон берёт нужную ширину ровно по
 * srcset — второй загрузки нет.
 *
 * Отдельной ручной предзагрузки здесь больше нет (вариант А, 19.10): React 19
 * сам отдаёт один preload для <img fetchPriority="high"> — проверено SSR-рендером
 * на установленном React 19.2.8. Ручной link рядом давал на проде два одинаковых
 * тега предзагрузки одного и того же srcset.
 *
 * Картинка декоративная: смысл героя — в заголовке поверх неё, поэтому alt
 * пустой. Ленивой загрузки нет и быть не может — это первый экран.
 */
export function HeroBackdrop({ src }: { src: string }) {
  const href = photoSrc(src, 1280);
  const srcSet = photoSrcSet(src);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="hero-img" src={href} srcSet={srcSet} sizes="100vw" alt="" fetchPriority="high" decoding="async" />
  );
}
