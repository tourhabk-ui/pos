import RouteLoading from '@/components/shared/RouteLoading';

// Скелет перехода: /car-rental стал целью кнопки «Прокат» на главной (23.10), и
// до готовности страницы (она читает прайс прокатчиков из базы) человек видел
// бы старый экран. В группе (list), а не над [slug]: под файлом загрузки
// notFound() карточки ушёл бы как 200 (сторож seo-audit-2909-structure).
export default function Loading() {
  return <RouteLoading />;
}
