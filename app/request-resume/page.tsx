import type { Metadata } from 'next';
import ResumeClient from './_ResumeClient';

export const metadata: Metadata = {
  title: 'Вернуться к заявке',
  robots: { index: false, follow: false },
};

export default function RequestResumePage() {
  return <ResumeClient />;
}
