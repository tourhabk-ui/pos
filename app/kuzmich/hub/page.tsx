import { redirect } from 'next/navigation';

/**
 * /kuzmich/hub — вторая главная, упразднена (перепись достижимости 22.08).
 *
 * Страница была полноценным лендингом: свой h1 в 8xl, четыре инструмента,
 * шесть карточек-стихий со ссылками в `/routes?...`, свой CTA. То есть делала
 * ровно ту работу, что делает главная (`components/homepage/`: HeroStatus,
 * BentoSection, StoriesRail, EditorialSection).
 *
 * При этом на неё не вела ни одна ссылка и её не было в sitemap — а
 * `robots: 'index, follow'` велел поисковику её индексировать. Получалось
 * худшее сочетание: человек попасть не может, робот обязан, и две страницы
 * платформы соревнуются за одни и те же запросы про Камчатку.
 *
 * URL сохранён редиректом — как у /on-route и /hub/operator/register.
 */
export default function KuzmichHubRedirect() {
  redirect('/');
}
