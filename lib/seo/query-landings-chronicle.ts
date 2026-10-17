/**
 * Статьи «Летописи Камчатки» для посадочных — по теме страницы: то же правило
 * слова целиком, что у туров (matchesTopicText), по заголовку и лиду статьи.
 * Текст статей не переводится и не пересказывается: только заголовок и ссылка.
 * У страниц «все туры» темы нет — они ведут на оглавление /letopis.
 */
import { CHRONICLE_ARTICLES, type ChronicleArticle } from '@/lib/chronicle/articles';
import { matchesTopicText } from '@/lib/seo/query-landings-data';
import type { LandingTopic } from '@/lib/seo/query-landings';

export function chronicleForTopic(topic: LandingTopic, articles: readonly ChronicleArticle[] = CHRONICLE_ARTICLES): ChronicleArticle[] {
  if (topic === 'all') return [];
  return articles.filter((a) => matchesTopicText(`${a.title} ${a.lead}`, topic));
}
