import { Metadata } from 'next';
import PricingClient from './_PricingClient';

export const metadata: Metadata = {
  title: 'Скидки | Оператор',
  description: 'Скидка на последние места и скидка группе — по своим турам',
  robots: 'noindex, nofollow',
};

export default function OperatorPricingPage() {
  return <PricingClient />;
}
