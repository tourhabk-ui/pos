import RouteLoading from '@/components/shared/RouteLoading';

/**
 * Скелет страницы края. Лежит в группе (list), а не в корне /weather:
 * файл загрузки в корне раздела обернул бы и /weather/[place], и их 404 и
 * 308 ушли бы наружу как 200 (тот же разбор, что у /catalog, аудит SEO 29.09).
 */
export default function Loading() {
  return <RouteLoading />;
}
