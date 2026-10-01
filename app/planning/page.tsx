import type { Metadata } from 'next';
import { PlanningClient } from './_PlanningClient';
import { MAP_PACK_BASE_URL_ENV } from '@/lib/map/pack-source';

export const metadata: Metadata = {
  alternates: { canonical: '/planning' },
  title: 'Планирование похода по Камчатке',
  description: 'Планирование похода по Камчатке: найдите место и маршрут к нему, проверьте готовность по списку и сохраните карту маршрута для работы без интернета.',
};

/**
 * Читаем адрес хранилища карт в момент ЗАПРОСА, а не сборки.
 *
 * `NEXT_PUBLIC_*` подставляется в бандл на этапе `next build`, а он у нас
 * идёт внутри образа Docker: в Dockerfile нет ни одного `ARG`/`ENV` для
 * таких переменных, и Timeweb отдаёт их контейнеру только при запуске.
 * Из-за этого клиент полдня получал пустую строку, пока сервер видел
 * правильное значение (разбор 01.09, см. шапку lib/map/pack-source.ts).
 *
 * Статическая страница читала бы env на сборке — то есть повторила бы ту же
 * ошибку. Поэтому рендер по запросу.
 */
export const dynamic = 'force-dynamic';

export default function PlanningPage() {
  const mapPackBaseUrl = process.env[MAP_PACK_BASE_URL_ENV] || null;
  // Экран-инструмент без видимого заголовка: H1 для поиска и экранного
  // диктора (аудит vedarai.ru 01.10 — H1 на странице не было вовсе).
  return (
    <>
      <h1 className="sr-only">Планирование похода по Камчатке</h1>
      <PlanningClient mapPackBaseUrl={mapPackBaseUrl} />
    </>
  );
}
