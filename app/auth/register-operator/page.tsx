import { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Регистрация оператора',
  description: 'Зарегистрируйтесь как туроператор на Kamchatour для размещения своих туров.',
};

export default function RegisterOperatorPage() {
  redirect('/operators/join');
}
