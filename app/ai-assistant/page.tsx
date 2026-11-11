import type { Metadata } from 'next';
import AIAssistantClient from './_AIAssistantClient';

export const metadata: Metadata = {
  // Без года: числом в коде он устаревал (владелец 11.11, «там же есть и
  // 2027»), а Кузьмич отвечает про любые даты, не про один сезон.
  title: 'AI-ассистент Кузьмич — туры на Камчатку',
  description: 'Бесплатный AI-помощник по турам на Камчатку. Кузьмич подберёт маршрут, рассчитает бюджет и ответит на вопросы о вулканах, рыбалке и медведях.',
  alternates: { canonical: '/ai-assistant' },
};

export default function AIAssistantPage() {
  return <AIAssistantClient />;
}
