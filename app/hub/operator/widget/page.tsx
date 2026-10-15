import { Metadata } from 'next';
import WidgetClient from './_WidgetClient';

export const metadata: Metadata = {
  title: 'Виджет на ваш сайт | Оператор',
  description: 'Код вставки чата и кнопки заявки, домены и отчёт за 30 дней',
  robots: 'noindex, nofollow',
};

export default function OperatorWidgetPage() {
  return <WidgetClient />;
}
