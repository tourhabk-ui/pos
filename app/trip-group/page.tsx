import type { Metadata } from 'next';
import { NewTripGroupClient } from './_NewTripGroupClient';

export const metadata: Metadata = {
  title: 'Спланировать поездку группой',
  description: 'Заведите группу на даты поездки и отправьте ссылку: каждый отметит свои пожелания, планер сведёт их в один маршрут.',
};

export default function NewTripGroupPage() {
  return <NewTripGroupClient />;
}
