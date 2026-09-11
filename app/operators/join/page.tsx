import type { Metadata } from 'next';
import JoinClient from './_JoinClient';
import { getPlatformCounts } from '@/lib/stats/platform-counts';
import { plural } from '@/lib/home/data-freshness';

export const metadata: Metadata = {
  title: 'Стать оператором',
  description: 'Зарегистрируйтесь как туроператор Камчатки. Первый месяц без комиссии.',
};

export default async function JoinPage() {
  /*
   * Цифра маршрутов — из базы, а не из памяти. На странице стояло «1189
   * маршрутов уже в базе», тогда как живых 392 (перепись 04.09): витрина для
   * операторов обещала втрое больше, чем есть (#1804). Правило честных цифр
   * главной действует и здесь; не смогли посчитать — строки нет вовсе, а не
   * выдуманное число.
   */
  let routesLine: string | null = null;
  try {
    const counts = await getPlatformCounts();
    if (counts.routes > 0) {
      routesLine = `${counts.routes.toLocaleString('ru-RU')} ${plural(counts.routes, 'маршрут', 'маршрута', 'маршрутов')} уже в базе — привяжите тур к маршруту`;
    }
  } catch (err) {
    console.error('[operators/join] счётчик маршрутов не получен', err instanceof Error ? err.message : String(err));
  }
  return <JoinClient routesLine={routesLine} />;
}
