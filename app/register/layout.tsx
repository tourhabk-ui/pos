import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Контроль возвращения и данные для заявки в МЧС',
  description: 'Включите контроль возвращения перед выходом на маршрут и соберите данные группы для заявки в МЧС. Заявку в МЧС подаёте вы — Ведар её не отправляет.',
  alternates: { canonical: '/register' },
  // Служебная форма контроля возвращения — не для выдачи (спецификация Сыщика 21.11).
  robots: { index: false, follow: true },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
