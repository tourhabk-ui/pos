import { Metadata } from 'next';
import { Suspense } from 'react';
import ConfirmClient from './_ConfirmClient';

export const metadata: Metadata = { title: 'Подтверждение цен | Оператор', robots: 'noindex, nofollow' };

export default function ConfirmPricePage() {
  return <Suspense fallback={null}><ConfirmClient /></Suspense>;
}
