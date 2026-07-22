import type { Metadata } from 'next';
import { CollectionsClient } from './_CollectionsClient';

export const metadata: Metadata = {
  title: 'Подборки маршрутов Камчатки',
  description: 'Кураторские подборки лучших мест и маршрутов Камчатки — вулканы, источники, дикая природа',
};

export default function CollectionsPage() {
  return <CollectionsClient />;
}
