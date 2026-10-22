import Link from 'next/link';
import { Footer } from '@/components/layout/Footer';
import { REQUISITES } from '@/lib/legal/requisites';

/**
 * Низ страниц каталога (/catalog и /marketplace — один монтаж).
 *
 * На всём пути покупки не было ни футера, ни юрлица: ни ООО и ИНН, ни оферты
 * (аудит П5, #30). По §2 футер — только desktop, поэтому на md+ — общий
 * <Footer>, а на телефоне — одна строка реквизитов из lib/legal/requisites
 * (единственный источник, руками не пишется).
 *
 * Нижний отступ телефонной строки — под таб-бар (`--bottom-nav-h`, его
 * публикует BottomNav), чтобы реквизиты не лежали под ним. Отступ остался
 * с запасом: плавающей кнопки заявки больше нет (19.10).
 */
export function CatalogFooter() {
  return (
    <>
      <div className="hidden md:block">
        <Footer />
      </div>
      <p
        className="md:hidden px-4 pt-6 text-xs leading-relaxed text-[var(--text-secondary)] text-center"
        style={{ paddingBottom: 'calc(var(--bottom-nav-h, 0px) + 88px)' }}
      >
        {REQUISITES.shortName} · ИНН {REQUISITES.inn} ·{' '}
        <Link href="/legal/offer" className="underline">Оферта</Link>
      </p>
    </>
  );
}
