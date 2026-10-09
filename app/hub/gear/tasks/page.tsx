import type { Metadata } from 'next';
import { TasksScreen } from '@/components/crm/TasksScreen';

export const metadata: Metadata = {
  title: 'Задачи | Прокат',
  description: 'Задачи партнёра: что сделать по клиентам и к какому сроку',
  robots: 'noindex, nofollow',
};

export default function GearTasksPage() {
  return <TasksScreen />;
}
