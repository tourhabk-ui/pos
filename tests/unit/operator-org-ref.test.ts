/**
 * Оператор тура в разметке — организация оператора, а не витрина (аудит 01.10).
 *
 * provider был `TouristInformationCenter` с именем оператора и адресом нашего
 * сайта: поисковик связывал тур с витриной, а не с тем, кто его проводит.
 * Теперь provider и seller — организация оператора с `@id`, который объявляет
 * его страница.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTourStructuredData, operatorOrganization, operatorOrgId } from '@/lib/seo/tour-structured-data';

const SITE = 'https://vedarai.ru';
const OPTS = { canonicalUrl: `${SITE}/catalog/tours/7`, siteUrl: SITE, activityLabel: 'Сплав', availability: null };
const BASE = { id: 7, title: 'Сплав', base_price: 9000, operator_name: 'Камчатка Рафтинг' };

type Graph = { '@graph': Array<Record<string, unknown>> };
const node = (g: Graph, type: string) => g['@graph'].find(n => n['@type'] === type)!;

describe('организация оператора', () => {
  it('страница оператора открыта — @id и её адрес', () => {
    expect(operatorOrganization(SITE, { ...BASE, operator_slug: 'kamchatka-rafting', operator_public: true })).toEqual({
      '@type': 'Organization',
      '@id': `${SITE}/operators/kamchatka-rafting#organization`,
      name: 'Камчатка Рафтинг',
      url: `${SITE}/operators/kamchatka-rafting`,
    });
  });

  it('страница закрыта или адреса нет — только имя, без чужого адреса', () => {
    expect(operatorOrganization(SITE, { ...BASE, operator_slug: 'x', operator_public: false })).toEqual({ '@type': 'Organization', name: 'Камчатка Рафтинг' });
    expect(operatorOrganization(SITE, { ...BASE, operator_slug: null, operator_public: true })).toEqual({ '@type': 'Organization', name: 'Камчатка Рафтинг' });
  });

  it('provider и seller тура — эта организация; адреса витрины в них нет', () => {
    const g = buildTourStructuredData({ ...BASE, operator_slug: 'kamchatka-rafting', operator_public: true }, [], OPTS) as unknown as Graph;
    const trip = node(g, 'TouristTrip');
    const product = node(g, 'Product');
    const id = operatorOrgId(SITE, 'kamchatka-rafting');
    expect((trip.provider as Record<string, unknown>)['@id']).toBe(id);
    expect(((product.offers as Record<string, unknown>).seller as Record<string, unknown>)['@id']).toBe(id);
    expect(JSON.stringify(g)).not.toMatch(/TouristInformationCenter/);
  });

  it('страница оператора объявляет организацию с тем же @id', () => {
    const page = readFileSync('app/operators/[slug]/page.tsx', 'utf-8');
    expect(page).toMatch(/'@id': operatorOrgId\(SITE, profile\.slug\)/);
    expect(page).toMatch(/<JsonLd data=\{orgJsonLd\} \/>/);
  });

  it('запрос карточки тура читает адрес и открытость страницы оператора', () => {
    const q = readFileSync('lib/tours/tour-detail-query.ts', 'utf-8');
    expect(q).toMatch(/p\.slug AS operator_slug, p\.is_public AS operator_public/);
  });
});
