import { Metadata } from 'next';
import KuzmichOutcomesClient from './_KuzmichOutcomesClient';

export const metadata: Metadata = { title: 'Кузьмич: плохие оценки | Админ', robots: 'noindex, nofollow' };

export default function KuzmichOutcomesPage() {
  return <KuzmichOutcomesClient />;
}
