/**
 * robots.txt сайта партнёра на его домене. Обходу открыта только главная и её
 * файлы: всё остальное, что приложение умеет отдать, — страницы Ведара, и под
 * адресом партнёра им не место (у них свой canonical на vedarai.ru).
 */
export function partnerRobots(sitemapUrl: string): string {
  return [
    'User-agent: *',
    'Allow: /$',
    'Allow: /images/',
    'Allow: /_next/',
    'Disallow: /',
    '',
    `Sitemap: ${sitemapUrl}`,
    '',
  ].join('\n');
}
