/**
 * AI-видимость каталога (аудит владельца 08.08 «Как ИИ видят vedarai.ru»:
 * сильный паспорт платформы, слепой коммерческий слой).
 *
 * Две находки одного класса с get_tours — фантомные колонки за молчаливым
 * catch:
 *   - sitemap фильтровал туры по is_visible — колонке PLACES, которой у
 *     operator_tours нет: запрос падал, и в sitemap не было ни одной
 *     карточки тура (обходчики не находили каталог);
 *   - llms.txt был силён по местам и слеп по коммерции: ни туров, ни
 *     планов, ни MCP — модели видели «энциклопедию Камчатки», не витрину.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SITEMAP = readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8');
const LLMS = readFileSync(join(ROOT, 'app/llms.txt/route.ts'), 'utf-8');

describe('sitemap: туры существуют для обходчиков', () => {
  it('фильтр — витринные флаги туров, а не фантомный is_visible', () => {
    const toursBlock = SITEMAP.slice(SITEMAP.indexOf('Маркетплейс-туры'), SITEMAP.indexOf('Подборки'));
    expect(toursBlock).toMatch(/is_active = TRUE/);
    expect(toursBlock).toMatch(/COALESCE\(is_published, TRUE\) = TRUE/);
    // Комментарий-история упоминает слово — запрещаем именно SQL-условие.
    expect(toursBlock).not.toMatch(/is_visible\s*=/);
  });

  it('падение запроса туров больше не молчит', () => {
    expect(SITEMAP).toMatch(/console\.error\('\[sitemap\]/);
  });
});

describe('llms.txt: коммерческий слой виден моделям', () => {
  it('живой каталог туров — та же витрина, что у sitemap и MCP', () => {
    expect(LLMS).toMatch(/FROM operator_tours ot/);
    expect(LLMS).toMatch(/LEFT JOIN partners p ON p\.id = ot\.operator_id/);
    expect(LLMS).toMatch(/COALESCE\(ot\.is_published, TRUE\) = TRUE/);
    expect(LLMS).toMatch(/Актуальные туры операторов/);
  });

  it('готовые планы — из единого источника PLAN_PRESETS', () => {
    expect(LLMS).toMatch(/from '@\/lib\/plans\/presets'/);
    expect(LLMS).toMatch(/Готовые планы поездок/);
  });

  it('MCP описан с честными границами: запись — только заявки', () => {
    expect(LLMS).toMatch(/MCP-сервер/);
    expect(LLMS).toMatch(/create_booking_request/);
    expect(LLMS).toMatch(/Мгновенной брони и оплаты через MCP нет by design/);
  });

  it('Last-Updated не отстаёт от Плана 2.0 и Эволюции 3.0', () => {
    expect(LLMS).toContain('Last-Updated: 2026-08-08');
    expect(LLMS).not.toContain('2026-07-26');
  });
});
