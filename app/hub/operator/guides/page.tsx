import { Metadata } from 'next';
import GuidesClient from './_GuidesClient';
export const metadata: Metadata = { title: 'Гиды', robots: 'noindex, nofollow' };
export default function GuidesPage() { return <GuidesClient />; }
