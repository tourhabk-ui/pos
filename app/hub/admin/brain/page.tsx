import type { Metadata } from 'next';
import { BrainClient } from './_BrainClient';

export const metadata: Metadata = {
  title: 'Brain — Память агентов',
  robots: 'noindex, nofollow',
};

export default function BrainPage() {
  return <BrainClient />;
}
