// @vitest-environment node
/**
 * Экран «Связи нет» (жалоба владельца 19.11): воркер отдаёт его и тогда, когда
 * сеть на устройстве есть, а страница не успела прийти. Экран говорит об этом
 * и даёт обновить страницу без JS; 112 остаётся первым действием.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import OfflinePage from '@/app/offline/page';

describe('экран «Связи нет»', () => {
  const html = renderToStaticMarkup(<OfflinePage />);

  it('называет третий исход: связь есть, страница не успела', () => {
    expect(html).toContain('Если интернет на устройстве есть, страница могла просто не успеть загрузиться.');
  });

  it('обновить можно без скриптов: форма GET без action просит тот же адрес', () => {
    const form = /<form[^>]*data-offline-retry[^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(form).not.toContain('action=');
    expect(html).toMatch(/<button type="submit"[^>]*>Обновить страницу<\/button>/);
    expect(html).not.toContain('<script');
  });

  it('звонок 112 стоит раньше просьбы обновить', () => {
    expect(html.indexOf('href="tel:112"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="tel:112"')).toBeLessThan(html.indexOf('data-offline-retry'));
  });
});
