import { Metadata } from 'next';
import AnalyticsClient from './_AnalyticsClient';
export const metadata: Metadata = { title: 'Аналитика', robots: 'noindex, nofollow' };
export default function AnalyticsPage() { return <AnalyticsClient />; }
