import type { Metadata } from 'next';
import { FieldCheckClient } from './_FieldCheckClient';

export const metadata: Metadata = {
  title: 'Полевая проверка маршрутов — Ведар',
  description: 'Сверка записей платформы с тем, что видно на месте.',
  robots: { index: false, follow: false },
};

export default function FieldCheckPage() {
  return <FieldCheckClient />;
}
