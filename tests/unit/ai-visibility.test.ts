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
    // Предикат витрины — один на sitemap, карточку и каталог (02.10: 12 туров
    // в sitemap против 11 на /about — разные условия и без связки с партнёром).
    expect(toursBlock).toMatch(/\$\{publicTourSql\('ot'\)\}/);
    expect(toursBlock).toMatch(/JOIN partners p ON ot\.operator_id = p\.id/);
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
    expect(LLMS).toMatch(/JOIN partners p ON p\.id = ot\.operator_id/);
    expect(LLMS).toMatch(/\$\{publicTourSql\('ot'\)\}/);
    expect(LLMS).toMatch(/Актуальные туры операторов/);
  });

  it('готовые планы — из единого источника PLAN_PRESETS', () => {
    expect(LLMS).toMatch(/from '@\/lib\/plans\/presets'/);
    expect(LLMS).toMatch(/Готовые планы поездок/);
  });

  it('MCP описан с честными границами: запись — только заявки', () => {
    expect(LLMS).toMatch(/MCP-сервер/);
    expect(LLMS).toMatch(/create_booking_request/);
    expect(LLMS).toMatch(/Мгновенного подтверждения и оплаты через MCP нет by design/);
  });

  it('Last-Updated — дата сборки ответа, а не замороженная строка', () => {
    // Списки туров и мест в llms.txt живые; дата «2026-08-08» стояла здесь
    // до 30.09 и выдавала файл за двухмесячный (замер 30.09).
    expect(LLMS).toContain('Last-Updated: ${new Date().toISOString().slice(0, 10)}');
    expect(LLMS).not.toMatch(/Last-Updated: \d{4}-\d{2}-\d{2}/);
  });
});
