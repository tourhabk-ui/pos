import type { Metadata } from 'next';
import { Header } from '@/components/layout/Header';
import WishlistClient from '@/app/hub/tourist/wishlist/_WishlistClient';

/**
 * /wishlist — избранное для ЛЮБОЙ вошедшей роли (слово владельца 09.10, §7).
 *
 * Сердечко на карточках каталога нажимается у оператора, гида, агента и
 * администратора, и с 09.10 сохраняется у всех (исключение на Edge,
 * middleware.ts). Но «Избранное» жило только в кабинете туриста
 * (/hub/tourist/wishlist, layout с ролью tourist): добавить мог кто угодно,
 * увидеть — только турист. Здесь тот же экран без кабинета-оболочки.
 */
export const metadata: Metadata = {
  title: 'Избранное',
  robots: 'noindex, nofollow',
};

export default function WishlistAnyRolePage() {
  return (
    <div className="ds-page" style={{ paddingBottom: 96 }}>
      <Header />
      <main className="pt-20">
        <WishlistClient anyRole />
      </main>
    </div>
  );
}
