import Image from 'next/image';

/**
 * Логотип партнёра (partners.logo_image) — одной вёрсткой на герой страницы
 * перевозчика и прокатчика и на карточку в списке. Нет логотипа — не рисует
 * ничего: заголовок остаётся как был (§4.0: пустого квадрата «тут мог быть
 * логотип» не бывает).
 *
 * Файл — путь под public/, кладётся миграцией партнёра с названным источником
 * (образцы: 1174, 1216, 1234, 1320). Вариантов WebP логотипу не режут: он
 * лёгкий и показывается не крупнее 80 px, next/image без оптимизатора отдаёт
 * файл как есть.
 *
 * Круг — потому что логотипы партнёров бывают любой формы, а в круге квадрат
 * с полями и круглый знак выглядят одинаково опрятно; `object-contain` не
 * режет знак, подложка — токен, не хардкод. В герое поверх фото подложки нет:
 * у логотипа свой фон или прозрачность, и стекло под круглым знаком лишнее.
 */
const SIZE = {
  hero: 'w-16 h-16 sm:w-20 sm:h-20',
  card: 'w-10 h-10 bg-[var(--bg-hover)]',
} as const;

export function PartnerLogo({ src, name, size, className = '' }: {
  src: string | null;
  name: string;
  size: keyof typeof SIZE;
  className?: string;
}) {
  if (!src) return null;
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-full ${SIZE[size]} ${className}`.trim()}>
      <Image src={src} alt={`Логотип: ${name}`} fill className="object-contain" sizes="80px" />
    </div>
  );
}
