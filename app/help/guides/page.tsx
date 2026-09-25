import type { Metadata } from 'next';
import HelpArticleView from '@/components/help/HelpArticleView';
import { GUIDES } from '@/lib/help/content';

export const metadata: Metadata = {
  title: 'Инструкция гида',
  description: 'Как гиду пройти проверку, внести аттестат до 1 октября, вступить в команду оператора и работать с группами',
};

export default function GuidesHelpPage() {
  return <HelpArticleView article={GUIDES} />;
}
