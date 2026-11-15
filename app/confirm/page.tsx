import type { Metadata } from 'next';
import { ConfirmClient } from './_ConfirmClient';

// Страница по личной ссылке — в поиск ей нельзя. Токен живёт во ФРАГМЕНТЕ
// адреса (#…): на сервер, в Referer и в метрику просмотров он не уходит.
export const metadata: Metadata = {
  title: 'Отправить заявку',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ConfirmClient />;
}
