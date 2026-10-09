import type { Metadata } from 'next';
import { TasksScreen } from '@/components/crm/TasksScreen';

export const metadata: Metadata = {
  title: 'Задачи | Оператор',
  description: 'Задачи партнёра: что сделать по клиентам и к какому сроку',
  robots: 'noindex, nofollow',
};

export default function OperatorTasksPage() {
  return <TasksScreen />;
}
