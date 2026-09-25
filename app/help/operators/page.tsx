import type { Metadata } from 'next';
import HelpArticleView from '@/components/help/HelpArticleView';
import { OPERATORS } from '@/lib/help/content';

export const metadata: Metadata = {
  title: 'Инструкция оператора',
  description: 'Как разместить тур, подключить уведомления, подтверждать брони, вести команду гидов и получать выплаты',
};

export default function OperatorsHelpPage() {
  return <HelpArticleView article={OPERATORS} />;
}
