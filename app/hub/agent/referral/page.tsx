import type { Metadata } from 'next';
import ReferralClient from './_ReferralClient';

export const metadata: Metadata = {
  title: 'Реферальные ссылки',
  description: 'Агентские реферальные ссылки и конверсии',
  robots: 'noindex, nofollow',
};

export default function AgentReferralPage() {
  return <ReferralClient />;
}
