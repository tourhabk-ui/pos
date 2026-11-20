import type { Metadata } from 'next';
import { ChangeConfirmClient } from './_ChangeConfirmClient';

// Страница по личной ссылке — в поиск ей нельзя. Токен живёт во ФРАГМЕНТЕ
// адреса (#…): на сервер и в Referer он не уходит. Счётчик Метрики здесь не
// грузится (префикс /confirm в METRIKA_EXCLUDED_PREFIXES).
export const metadata: Metadata = {
  title: 'Подтвердить изменение заявки',
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ChangeConfirmClient />;
}
