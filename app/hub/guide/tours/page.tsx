import { Metadata } from 'next';
import GuideToursClient from './_GuideToursClient';

export const metadata: Metadata = {
  title: 'Мои туры | Кабинет гида | Ведар',
};

export default function GuideTourPage() {
  return <GuideToursClient />;
}
