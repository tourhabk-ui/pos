import type { Metadata } from 'next';
import { RequestStatusClient } from './_RequestStatusClient';

// Страница по личному ключу — в поиск ей нельзя. Ключ живёт во ФРАГМЕНТЕ
// адреса (#…): он не уходит на сервер, в Referer и в метрику просмотров
// (page_views), где ключ в пути оседал бы открытым текстом — как у /seat-request.
export const metadata: Metadata = {
  title: 'Состояние заявки',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <RequestStatusClient />;
}
