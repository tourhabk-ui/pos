/**
 * Памятка «Как подготовиться к поездке на Камчатку» (/prepare, 30.09).
 *
 * Правило страницы — ни одного критичного факта своими словами: сроки МЧС,
 * каналы подачи, разрешение парка, шкала сложности, медвежий протокол,
 * реки и погода, номера — импортом из справочников. Сторож ловит самую
 * вероятную порчу: кто-то перепишет «10 рабочих дней» или номер руками, и
 * через месяц справочник обновится, а памятка — нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MCHS_LEAD_WORKING_DAYS } from '@/lib/safety/mchs-registration';

const read = (p: string) => readFileSync(p, 'utf-8');
const PAGE = read('app/prepare/page.tsx');
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('/prepare: факты из справочников', () => {
  it('берёт МЧС, парк, сложность, руководства и номера импортом', () => {
    expect(PAGE).toMatch(/from '@\/lib\/safety\/mchs-registration'/);
    expect(PAGE).toMatch(/from '@\/lib\/safety\/park-permit'/);
    expect(PAGE).toMatch(/from '@\/lib\/routes\/difficulty-scale'/);
    expect(PAGE).toMatch(/alertGuidance\('bear'\)/);
    expect(PAGE).toMatch(/alertGuidance\('flood'\)/);
    expect(PAGE).toMatch(/alertGuidance\('weather'\)/);
    expect(PAGE).toMatch(/EMERGENCY_NUMBERS\.map/);
  });

  it('в тексте нет вписанных руками сроков и номеров', () => {
    expect(CODE).not.toMatch(new RegExp(`\\b${MCHS_LEAD_WORKING_DAYS}\\s+рабоч`));
    expect(CODE).not.toMatch(/\+7[\s(]*4152/);
    expect(CODE).not.toMatch(/['">]\s*112\b/);
    expect(CODE).not.toContain('forms.mchs.gov.ru');
  });

  it('пороги сложности не переписаны: строка строится из DIFFICULTY_SCALE', () => {
    expect(CODE).toMatch(/DIFFICULTY_SCALE\.map\(/);
    expect(CODE).not.toMatch(/\b(400|1000|2000)\s*м/);
  });

  it('FAQ-разметка — из тех же справочников', () => {
    expect(PAGE).toMatch(/<FAQJsonLd questions=\{faq\} \/>/);
    expect(PAGE).toMatch(/answer: `\$\{MCHS_DEADLINE_SHORT\}/);
    expect(PAGE).toMatch(/answer: bear\.steps\.join/);
  });

  it('canonical и H1 есть', () => {
    expect(PAGE).toMatch(/canonical: `\$\{SITE\}\/prepare`/);
    expect(PAGE).toMatch(/<h1[^>]*>\s*\{TITLE\}/);
  });
});

describe('/prepare достижима', () => {
  it('в sitemap и в меню платформы', () => {
    expect(read('lib/seo/sitemap-entries.ts')).toMatch(/\$\{BASE\}\/prepare`/);
    expect(read('lib/navigation/platform-links.ts')).toMatch(/href: '\/prepare'/);
  });
});
