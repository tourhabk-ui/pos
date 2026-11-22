import { Metadata } from 'next';
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { verifySessionToken } from '@/lib/auth/jwt';
import { Header } from '@/components/layout/Header';
import { PlannerClient } from './_PlannerClient';
import { PlannerLoginGate } from '@/components/planner/PlannerLoginGate';
import { PLANNER_NAME } from '@/lib/navigation/tool-names';

export const metadata: Metadata = {
  alternates: { canonical: '/planner' },
  title: PLANNER_NAME,
  description: 'Соберите план поездки по Камчатке по дням вместе с Кузьмичом: выберите активности, поправьте каждый день и сохраните план в личном кабинете.',
  // С 14.11 планер открывается только после входа (слово владельца «6-3»):
  // поисковику страница показывает экран входа — индексировать нечего.
  robots: { index: false, follow: true },
};

export default async function PlannerPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get('auth_token')?.value ?? null;
  // Подпись И живая строка сессии (аудит 15.10, P3-01): по одной подписи
  // вышедший ещё до 7 дней видел планер «вошедшим».
  //
  // С 14.11 это гейт, а не персонализация (слово владельца «6-3»: без входа
  // планер не работает; «6 хранить в лк»): план хранится в личном кабинете.
  // Не смогли сверить сессию — планер не открывается, и сказано «не смогли
  // проверить», а не «вы не вошли» (§4.0); причина уже в логе checkSession.
  const session = token ? await verifySessionToken(token) : null;

  return (
    <>
      <Header />
      {session?.status === 'valid' ? (
        <Suspense>
          <PlannerClient initialUserId={session.payload.userId} />
        </Suspense>
      ) : (
        <PlannerLoginGate gate={session?.status === 'unchecked' ? 'unchecked' : 'sign_in'} />
      )}
    </>
  );
}
