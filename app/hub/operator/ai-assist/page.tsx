import { Metadata } from 'next';
import { AIAssistClient } from './AIAssistClient';

export const metadata: Metadata = {
  title: 'Помощник | Оператор',
};

export default function AIAssistPage() {
  return <AIAssistClient />;
}
