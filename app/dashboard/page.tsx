import { redirect } from 'next/navigation';

// /dashboard — осиротевший «командный центр», перекрыт живой Главной v8
// (июль 2026). Ни одной входящей ссылки; редиректим на Главную.
// Клиент _DashboardClient.tsx оставлен на случай возрождения отдельным входом.
export default function DashboardPage() {
  redirect('/');
}
