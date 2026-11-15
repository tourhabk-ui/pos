import type { Metadata } from 'next';
import { ConfirmClient } from './_ConfirmClient';

// Страница по личной ссылке — в поиск ей нельзя. Токен живёт во ФРАГМЕНТЕ
// адреса (#…): на сервер и в Referer он не уходит. Счётчик Метрики здесь не
// грузится вовсе (lib/analytics/metrika, METRIKA_EXCLUDED_PREFIXES): вебвизор
// записал бы адрес с токеном, имя и черновик.
export const metadata: Metadata = {
  title: 'Отправить заявку',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ConfirmClient />;
}
