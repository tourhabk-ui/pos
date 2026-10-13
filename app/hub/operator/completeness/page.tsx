import { Metadata } from 'next';
import CompletenessClient from './_CompletenessClient';

export const metadata: Metadata = {
  title: 'Чего не хватает турам | Оператор',
  description: 'Готовность туров к витринам: что заполнить и где',
  robots: 'noindex, nofollow',
};

export default function CompletenessPage() {
  return <CompletenessClient />;
}
