'use client';

import { ReactNode, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, BookUser, ListChecks, BellDot, CarFront } from 'lucide-react';
import { HubLayout } from '@/components/layout/HubLayout';
import { PartnerChannelBanner } from '@/components/hub/PartnerChannelBanner';
import { PartnerOfferBanner } from '@/components/hub/PartnerOfferBanner';
import { useAuth } from '@/contexts/AuthContext';

// Кабинет перевозчика: парк машин (с 13.10 без поездок и запросов мест —
// трансфер продаётся машиной целиком). Клиенты — отдельным разделом: экран CRM
// общий для всех партнёров (CRM #2325). «Прокат» — машины без водителя,
// заявки и календарь (владелец 26.10, «Лагуна Прокат»).
const SIDEBAR_ITEMS = [
  { href: '/hub/carrier', label: 'Кабинет', icon: LayoutDashboard },
  { href: '/hub/carrier/rental', label: 'Прокат', icon: CarFront },
  { href: '/hub/carrier/inbox', label: 'Входящие', icon: BellDot },
  { href: '/hub/carrier/clients', label: 'Клиенты', icon: BookUser },
  { href: '/hub/carrier/tasks', label: 'Задачи', icon: ListChecks },
];

// Прокат автомобилей (роль cars, 23.11): тот же кабинет без раздела
// перевозчика — парк и прайс «под заказ» ему закрыты и на сервере
// (lib/transfers/carrier-auth).
const RENTAL_HOME = '/hub/carrier/rental';
const RENTAL_SIDEBAR_ITEMS = SIDEBAR_ITEMS.filter((item) => item.href !== '/hub/carrier');

export default function CarrierHubLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const rentalOnly = user?.role === 'cars';

  // Главная кабинета — раздел перевозчика: прокатчика ведём в его раздел.
  useEffect(() => {
    if (rentalOnly && pathname === '/hub/carrier') router.replace(RENTAL_HOME);
  }, [rentalOnly, pathname, router]);

  return (
    <HubLayout
      sidebarItems={rentalOnly ? RENTAL_SIDEBAR_ITEMS : SIDEBAR_ITEMS}
      sidebarTitle={rentalOnly ? 'Прокат автомобилей' : 'Перевозчик'}
      requiredRole={['transfer', 'transfer_operator', 'cars', 'admin']}
    >
      <PartnerChannelBanner />
      <PartnerOfferBanner />
      {rentalOnly && pathname === '/hub/carrier' ? null : children}
    </HubLayout>
  );
}
