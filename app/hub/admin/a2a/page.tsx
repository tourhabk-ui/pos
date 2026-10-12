import type { Metadata } from 'next';
import A2aClient from './_A2aClient';

export const metadata: Metadata = {
  title: 'A2A: кто приходит из ИИ | Админ',
  description: 'Журнал запросов A2A, клиенты MCP и чтение визиток обходчиками',
  robots: 'noindex, nofollow',
};

export default function AdminA2aPage() {
  return <A2aClient />;
}
