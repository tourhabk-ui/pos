import type { Metadata } from 'next';
import SafetyClient from './_SafetyClient';

export const metadata: Metadata = { title: 'Контрольный срок' };

export default function Page() {
  return <SafetyClient />;
}
