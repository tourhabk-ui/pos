import { Metadata } from 'next';
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { verifySessionToken } from '@/lib/auth/jwt';
import { Header } from '@/components/layout/Header';
import { PlannerClient } from './_PlannerClient';

export const metadata: Metadata = {
  alternates: { canonical: '/planner' },
  title: 'Конструктор маршрута — Камчатка',
  description: 'Постройте идеальный маршрут по Камчатке: выберите активности, получите AI-рекомендацию и настройте каждый день поездки.',
};

export default async function PlannerPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get('auth_token')?.value ?? null;
  // Подпись И живая строка сессии (аудит 15.10, P3-01): по одной подписи
  // вышедший ещё до 7 дней видел планер «вошедшим». Не смогли сверить —
  // планер открывается гостем (это персонализация, не гейт: сохранение плана
  // идёт через API с проверкой сессии), причина уже в логе checkSession.
  const session = token ? await verifySessionToken(token) : null;
  const initialUserId = session?.status === 'valid' ? session.payload.userId : null;

  return (
    <>
      <Header />
      <Suspense>
        <PlannerClient initialUserId={initialUserId} />
      </Suspense>
    </>
  );
}
