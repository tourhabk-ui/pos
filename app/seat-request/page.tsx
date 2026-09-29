import type { Metadata } from 'next';
import { SeatRequestStatusClient } from './_SeatRequestStatusClient';

// Страница по личному ключу — в поиск ей нельзя. Ключ живёт во ФРАГМЕНТЕ
// адреса (#…): он не уходит на сервер, в Referer и в собственную метрику
// просмотров (page_views), где ключ в пути оседал бы открытым текстом.
export const metadata: Metadata = {
  title: 'Запрос свободных мест',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <SeatRequestStatusClient />;
}
