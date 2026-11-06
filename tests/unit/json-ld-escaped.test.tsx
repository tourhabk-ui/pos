/**
 * JSON-LD на страницах — без голого JSON.stringify (разбор 06.11).
 *
 * Название тура, отзыв туриста, имя оператора и гида пишут роли с
 * самостоятельной регистрацией. JSON.stringify не экранирует «<», и строка
 * `</script><script>…` закрыла бы тег разметки и выполнилась у каждого
 * посетителя страницы тура, каталога, операторов, гидов. Компонент JsonLd с
 * экранированием был, но двенадцать страниц и корневой шаблон его обходили —
 * пятнадцать вставок.
 *
 * Проверка поведения — исполнением помощника и рендером компонента; запрет
 * голого JSON.stringify в `__html` — регуляркой по исходникам (это запрет,
 * «этого быть не должно», CLAUDE.md §4).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { jsonLdHtml } from '@/lib/seo/json-ld-html';
import { JsonLd } from '@/components/seo/JsonLd';

const HOSTILE = {
  '@type': 'TouristTrip',
  name: 'Тур</script><script>window.__pwned=1</script>',
  description: 'Строка с разделителем',
  review: [{ reviewBody: '<!-- </SCRIPT ><img src=x onerror=alert(1)>' }],
};

describe('помощник экранирует то, что закрыло бы тег', () => {
  it('ни «</script», ни «<!--», ни сырого U+2028 — а данные читаются обратно те же', () => {
    const out = jsonLdHtml(HOSTILE);
    expect(out.toLowerCase()).not.toContain('</script');
    expect(out).not.toContain('<');
    expect(out).not.toContain(' ');
    expect(JSON.parse(out)).toEqual(HOSTILE);
  });

  it('компонент JsonLd рендерит тот же безопасный текст', () => {
    const html = renderToStaticMarkup(<JsonLd data={HOSTILE} />);
    const body = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'));
    expect(body.toLowerCase()).not.toContain('</script');
    expect(JSON.parse(body)).toEqual(HOSTILE);
  });
});

describe('запрет: голого JSON.stringify в __html нет ни на одной странице', () => {
  function walk(dir: string, out: string[]): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) out.push(p);
    }
    return out;
  }

  it('app/ и components/ вставляют разметку только через jsonLdHtml или JsonLd', () => {
    const files = [...walk('app', []), ...walk('components', [])];
    expect(files.length, 'исходники найдены, а не пусто').toBeGreaterThan(100);
    const bare = files.filter((f) => /__html\s*:\s*JSON\.stringify\s*\(/.test(readFileSync(f, 'utf-8')));
    expect(bare).toEqual([]);
  });
});
