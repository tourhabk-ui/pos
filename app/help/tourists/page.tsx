import type { Metadata } from 'next';
import HelpArticleView from '@/components/help/HelpArticleView';
import { TOURISTS } from '@/lib/help/content';

export const metadata: Metadata = {
  title: 'Помощь туристам',
  description: 'Как найти тур на Камчатке, оставить заявку, оплатить после подтверждения оператора и отменить бронь',
};

export default function TouristsHelpPage() {
  return <HelpArticleView article={TOURISTS} />;
}
