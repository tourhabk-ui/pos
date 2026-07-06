import type { Metadata } from 'next';
import CheckoutClient from './_CheckoutClient';

export const metadata: Metadata = {
  title: 'Оформление заявок | TourHab',
  description: 'Оформление заявок на туры из корзины',
};

export default function CheckoutPage() {
  return <CheckoutClient />;
}
