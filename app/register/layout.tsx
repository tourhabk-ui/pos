import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Регистрация маршрута в МЧС | Ведар',
  description: 'Зарегистрируйте туристический маршрут перед выходом в поле. Ведар — безопасность на Камчатке.',
  alternates: { canonical: '/register' },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
