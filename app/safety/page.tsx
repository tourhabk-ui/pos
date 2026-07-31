import type { Metadata } from 'next';
import SafetyClient from './_SafetyClient';
import { getSafetyLiveData } from '@/app/_home/data';

// Живая обстановка меняется каждые минуты — не кэшировать статикой.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Безопасность на Камчатке',
  description: 'Актуальная сейсмика, вулканическая активность, зоны риска и AI Спасатель для туристов на Камчатке.',
  alternates: { canonical: '/safety' },
};

export default async function SafetyPage() {
  // P0-3b: радар/лента/пульс живут здесь; данные — тем же серверным
  // построителем, что кормил главную (один источник, ноль дублей).
  const live = await getSafetyLiveData().catch(() => null);
  return <SafetyClient live={live} />;
}
