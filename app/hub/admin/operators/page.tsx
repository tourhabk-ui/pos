import { Metadata } from 'next';
import OperatorsClient from './_OperatorsClient';
export const metadata: Metadata = { title: 'Операторы | Админ', robots: 'noindex, nofollow' };
export default function OperatorsPage() { return <OperatorsClient />; }
