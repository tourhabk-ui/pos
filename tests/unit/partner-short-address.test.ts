// @vitest-environment node
/**
 * Короткий адрес партнёра vedarai.ru/<slug> и форма на странице оператора
 * (решение владельца 13.10: «форму можно, адрес vedarai.ru/<slug>»).
 *
 * Что держит сторож:
 *  - app/[slug] — та же страница оператора (тот же модуль и его же
 *    generateMetadata), а не копия: две копии одной страницы уже
 *    расходились на карточке тура (§11 CLAUDE.md);
 *  - canonical остаётся /operators/<slug>: короткий адрес — для людей и QR,
 *    в поиске страница одна;
 *  - в базу пускается только форма slug (lib/partners/short-address): точка,
 *    кириллица и заглавные — notFound без запроса;
 *  - у известных партнёров slug не совпадает с именем верхнего раздела
 *    сайта — такому партнёру короткий адрес не достался бы (статика
 *    у Next старше);
 *  - на странице оператора есть якорь #lead-form, кнопка к нему в герое и
 *    сама форма с slug партнёра.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isShortSlug, SHORT_SLUG_RE } from '@/lib/partners/short-address';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const SHORT = read('app/[slug]/page.tsx');
const OPERATOR = read('app/operators/[slug]/page.tsx');

/** Партнёры с заполненными страницами (1106, 1174, 1216, 060). */
const KNOWN_PARTNER_SLUGS = ['fishingkam', 'kamchatskaya-rybalka', 'mestechko', 'volcanoesland', 'kamchatka-rafting'];

describe('форма slug короткого адреса', () => {
  it('принимает slug партнёров', () => {
    for (const s of KNOWN_PARTNER_SLUGS) expect(isShortSlug(s), s).toBe(true);
  });

  it('не пускает в базу точку, заглавные, кириллицу, подчёркивание, пустоту и длину за сотню', () => {
    for (const s of ['x.png', 'Mestechko', 'тест', 'a_b', '', 'a', '-a', 'a'.repeat(101), 'a/b', 'a b']) {
      expect(isShortSlug(s), JSON.stringify(s)).toBe(false);
    }
    expect(SHORT_SLUG_RE.source).toContain('{1,99}');
  });

  it('slug партнёров не совпадает с именами верхних разделов сайта', () => {
    const sections = readdirSync(join(ROOT, 'app')).filter((n) => statSync(join(ROOT, 'app', n)).isDirectory() && !n.startsWith('[') && !n.startsWith('_'));
    expect(sections.length).toBeGreaterThan(20);
    for (const s of KNOWN_PARTNER_SLUGS) expect(sections, s).not.toContain(s);
  });
});

describe('app/[slug] — та же страница оператора', () => {
  it('рендерит модуль страницы оператора и зовёт его generateMetadata', () => {
    expect(SHORT).toMatch(/import OperatorProfilePage, \{ generateMetadata as operatorMetadata \} from '@\/app\/operators\/\[slug\]\/page'/);
    expect(SHORT).toContain('<OperatorProfilePage params={props.params} />');
    expect(SHORT).toContain('return operatorMetadata(props);');
  });

  it('чужая форма slug — notFound и noindex, без похода в базу', () => {
    expect(SHORT).toContain("import { isShortSlug } from '@/lib/partners/short-address'");
    expect(SHORT).toMatch(/if \(!isShortSlug\(slug\)\) notFound\(\);/);
    expect(SHORT).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(SHORT).not.toMatch(/from '@\/lib\/database'|FROM partners/);
  });

  it('canonical остаётся /operators/<slug>', () => {
    expect(OPERATOR).toContain('alternates: { canonical: `${SITE}/operators/${profile.slug}` }');
    // Свой canonical короткая страница не ставит — берёт его из generateMetadata страницы оператора.
    expect(SHORT).not.toMatch(/alternates\s*:/);
  });
});

describe('страница оператора — форма в ящик оператора', () => {
  it('кнопка в герое ведёт к якорю, якорь на секции формы', () => {
    expect(OPERATOR).toContain('href="#lead-form"');
    expect(OPERATOR).toContain('id="lead-form"');
    expect(OPERATOR).toContain('Написать оператору');
  });

  it('форма получает slug и имя оператора', () => {
    expect(OPERATOR).toContain("import { OperatorLeadForm } from '@/components/operators/OperatorLeadForm'");
    expect(OPERATOR).toContain('<OperatorLeadForm partnerSlug={profile.slug} partnerName={profile.name} />');
  });

  it('кнопки «Забронировать» на профиле по-прежнему нет (владелец 02.10)', () => {
    const code = OPERATOR.replace(/\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, '');
    expect(code).not.toMatch(/Забронировать/);
  });
});
