import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Контроль возвращения и данные для заявки в МЧС',
  description: 'Включите контроль возвращения перед выходом на маршрут и соберите данные группы для заявки в МЧС. Заявку в МЧС подаёте вы — Ведар её не отправляет.',
  alternates: { canonical: '/register' },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
