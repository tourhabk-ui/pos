import type { Metadata } from 'next';
import SelectionsClient from './_SelectionsClient';

export const metadata: Metadata = {
  title: 'Подборки туров | Оператор',
  robots: 'noindex, nofollow',
};

export default function SelectionsPage() {
  return <SelectionsClient />;
}
