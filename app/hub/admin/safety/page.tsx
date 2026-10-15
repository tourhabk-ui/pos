import { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySessionToken } from '@/lib/auth/jwt';
import { SafetyDashboardClient } from './SafetyDashboardClient';

export const metadata: Metadata = {
  title: 'Safety Dashboard',
  description: 'Real-time safety monitoring and alerts',
};

export default async function SafetyDashboard() {
  const cookieStore = await cookies();
  const token = cookieStore.get('auth_token')?.value;
  // Подпись И живая строка сессии (аудит 15.10, P3-01): по одной подписи
  // вышедший админ проходил ещё до 7 дней. Не смогли сверить — тоже не
  // пускаем: для своей страницы «не знаю» блокирует (§4.0), причина в логе.
  const session = token ? await verifySessionToken(token) : null;
  const user = session?.status === 'valid' ? session.payload : null;

  if (!user || user.role !== 'admin') {
    redirect('/auth/login?from=/hub/admin/safety');
  }

  return <SafetyDashboardClient />;
}
