import type { Metadata } from 'next';
import SafetyClient from './_SafetyClient';
import MarineMammalRules from '@/components/safety/MarineMammalRules';
import { getSafetyLiveData } from '@/app/_home/data';

// Живая обстановка меняется каждые минуты — не кэшировать статикой.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // Вопрос человека — «безопасно ли сейчас ехать»; страница на него отвечает
  // живыми данными, поэтому и заголовок собран вокруг него (срез 02.10).
  title: 'Безопасно ли сейчас на Камчатке: сейсмика, вулканы, зоны риска',
  description: 'Обстановка на Камчатке сегодня: землетрясения, активность вулканов, зоны риска и погода — обновляется автоматически. Спасатель и SOS для туристов.',
  alternates: { canonical: '/safety' },
};

export default async function SafetyPage() {
  // P0-3b: радар/лента/пульс живут здесь; данные — тем же серверным
  // построителем, что кормил главную (один источник, ноль дублей).
  const live = await getSafetyLiveData().catch(() => null);
  return <SafetyClient live={live} rules={<MarineMammalRules />} />;
}
