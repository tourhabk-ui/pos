import { Metadata } from 'next';
import KuzmichSafetyClient from './_KuzmichSafetyClient';
export const metadata: Metadata = { title: 'Кузьмич: безопасность | Админ', robots: 'noindex, nofollow' };
export default function KuzmichSafetyPage() { return <KuzmichSafetyClient />; }
