import type { Metadata } from 'next';
import GearModerationClient from './_GearModerationClient';

export const metadata: Metadata = { title: 'Прокат: проверка | Админ', robots: 'noindex, nofollow' };

export default function GearModerationPage() {
  return <GearModerationClient />;
}
