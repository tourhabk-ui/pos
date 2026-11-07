/**
 * Сторонние приложения в дорогу (решение владельца 07.11, миграция 1396).
 *
 * Владелец считал каталог /hub/admin/taaft нашими инструментами. Это чужие
 * приложения: 48 посеянных 666 записей, «проверенные» скопом (668), с
 * чужим SOS-сервисом и лавинным прогнозом США. Осталось пять, без
 * безопасности. Сторож судит поведение:
 *   - подбор под задачу: находит по смыслу слов, промах — весь список, а не
 *     «похожее» наугад; служебные слова просьбы не подбирают;
 *   - ответ Кузьмичу: «сторонние», безопасность — Ведар и 112, у
 *     определителей — не про съедобность; счётчик попаданий не пишется;
 *   - миграция: удаляет ровно посеянное, кроме пяти, только source='taaft';
 *     у оставшихся нет чисел и безопасности;
 *   - адреса прежних страниц приложений ведут на список;
 *   - публичный API: порядок назван, рейтинга и счётчика попаданий нет,
 *     отказ счётчика щелчков назван в логе.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { matchApps, queryRoots, formatAppsForKuzmich, NATURE_CAUTION, SAFETY_POINTER, type ExternalTool } from '@/lib/travel-apps/catalog';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';

const app = (slug: string, name: string, category: string, description: string, tags: string[] = []): ExternalTool =>
  ({ id: slug, slug, name, category, description, tags, url: `https://${slug}.example`, is_free: true });

/** Пять приложений — тексты те же, что кладёт 1396. */
const APPS: ExternalTool[] = [
  app('organic-maps', 'Organic Maps', 'maps', 'Офлайн-карты и навигация на основе OpenStreetMap: пешком, на велосипеде, на машине. Работает без интернета; бесплатно, без рекламы.', ['офлайн', 'карты', 'навигация', 'osm']),
  app('wikiloc', 'Wikiloc', 'maps', 'GPS-треки, которые выкладывают сами туристы: поиск маршрутов рядом с точкой на карте. Основное бесплатно; навигация по треку с подсказками — по подписке Premium.', ['треки', 'gpx', 'маршруты', 'туристы']),
  app('peakbagger', 'Peakbagger', 'maps', 'База вершин мира: высоты, отчёты о восхождениях и GPX-треки от самих восходителей. Бесплатно.', ['вершины', 'восхождения', 'вулканы', 'gpx']),
  app('plantnet', 'Pl@ntNet', 'nature', 'Определение растения по фото листа, цветка, плода или коры: приложение предлагает похожие виды. Бесплатное, его делает научный консорциум (Cirad, INRAE, Inria, IRD).', ['растения', 'фото', 'определение']),
  app('inaturalist', 'iNaturalist', 'nature', 'Определение животных, растений и грибов по фото: приложение предлагает похожие виды, наблюдения проверяют другие натуралисты. Бесплатное, некоммерческое.', ['животные', 'растения', 'грибы', 'птицы', 'фото', 'определение']),
];

const slugs = (xs: ExternalTool[]) => xs.map((x) => x.slug);

beforeEach(() => { query.mockReset(); });

describe('подбор под задачу', () => {
  it('находит по смыслу слов, а не по точной фразе', () => {
    // Пример из описания самого инструмента до 07.11 — поиск «simple + все слова» не находил ничего.
    expect(slugs(matchApps('определить растение на фото', APPS)).sort()).toEqual(['inaturalist', 'plantnet']);
    expect(slugs(matchApps('офлайн карта', APPS))[0]).toBe('organic-maps');
    expect(slugs(matchApps('треки на вулкан', APPS))[0]).toBe('peakbagger');
    expect(slugs(matchApps('какой это гриб', APPS))).toEqual(['inaturalist']);
  });

  it('безопасность и чужие задачи не подбираются; служебные слова просьбы не считаются', () => {
    for (const task of ['лавинная обстановка', 'sos', 'экстренная связь', 'транскрибировать аудио', 'посоветуй приложение', '']) {
      expect(matchApps(task, APPS), task).toEqual([]);
    }
    expect(queryRoots('Посоветуй приложение, чтобы найти треки')).toEqual(['трек']);
  });
});

describe('ответ Кузьмичу', () => {
  it('подошедшее — списком, «сторонние», безопасность — Ведар и 112, у определителей — не про съедобность', () => {
    const text = formatAppsForKuzmich(matchApps('определить растение на фото', APPS), APPS);
    expect(text).toContain('Сторонние приложения — их делают другие компании, Ведар за них не отвечает');
    expect(text).toContain('Под задачу подходят:');
    expect(text).toContain('Pl@ntNet');
    expect(text).not.toContain('Organic Maps');
    expect(text).toContain(NATURE_CAUTION);
    expect(text).toContain(SAFETY_POINTER);
  });

  it('промах — так и сказано, и дан весь короткий список, а не «похожее»', () => {
    const text = formatAppsForKuzmich(matchApps('лавинная обстановка', APPS), APPS);
    expect(text).toContain('Под эту задачу в списке ничего нет. Весь список (5):');
    for (const a of APPS) expect(text).toContain(a.name);
    expect(text).toContain('112');
  });

  it('карты без определителей — без оговорки про съедобность; пустой список назван пустым', () => {
    expect(formatAppsForKuzmich(matchApps('офлайн карта', APPS), APPS)).not.toContain(NATURE_CAUTION);
    expect(formatAppsForKuzmich([], [])).toContain('Список сторонних приложений пуст.');
  });

  it('инструмент search_taaft читает список и ничего не пишет: счётчик попаданий снят', async () => {
    query.mockResolvedValue({ rows: APPS });
    const out = await executeKuzmichTool('search_taaft', { task: 'определить растение на фото' });
    expect(out).toContain('Pl@ntNet');
    expect(out).toContain('Сторонние приложения');
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /FROM external_tools/.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE external_tools/i.test(s))).toBe(false);
  });

  it('описание инструмента для модели не обещает безопасность и чужие задачи', () => {
    const def = KUZMICH_TOOLS.find((t) => t.function.name === 'search_taaft');
    const description = String(def?.function.description);
    expect(description).toContain('Не для безопасности');
    expect(description).toContain('112');
    expect(description).not.toMatch(/лавинн|транскриб|аудиогид/i);
  });
});

describe('миграция 1396', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), 'migrations', f), 'utf-8');
  const seed = [...read('666_external_tools.sql').matchAll(/^\s*\('([a-z0-9-]+)',/gm)].map((m) => m[1]);
  const sql = read('1396_external_tools_travel_apps.sql');
  const deleteBlock = sql.slice(sql.indexOf('DELETE FROM external_tools'), sql.indexOf(');', sql.indexOf('DELETE FROM external_tools')));
  const deleted = [...deleteBlock.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).filter((s) => s !== 'taaft');
  const kept = [...sql.matchAll(/^\s*\('([a-z0-9-]+)', '[^']+',$/gm)].map((m) => m[1]);

  it('удаляет ровно посеянное 666, кроме пяти, и только с меткой посева', () => {
    expect(seed).toHaveLength(48);
    expect(kept.sort()).toEqual(['inaturalist', 'organic-maps', 'peakbagger', 'plantnet', 'wikiloc']);
    expect([...deleted, ...kept].sort()).toEqual([...seed].sort());
    expect(deleteBlock).toMatch(/WHERE source = 'taaft'/);
  });

  it('безопасность, SOS и сервисы, которые делает сам Ведар, удалены', () => {
    for (const s of ['sos-share', 'avalanche-forecast', 'magma-volcano', 'emergency-response-africa', 'windy', 'claude-ai', 'whisper-openai']) {
      expect(deleted, s).toContain(s);
    }
  });

  it('у оставшихся нет чисел, которые нечем подтвердить, и нет раздела безопасности', () => {
    const values = sql.slice(sql.indexOf('FROM (VALUES'), sql.indexOf(') AS v('));
    const descriptions = [...values.matchAll(/^\s+'([^']{40,})',$/gm)].map((m) => m[1]);
    expect(descriptions).toHaveLength(5);
    for (const d of descriptions) expect(d, d).not.toMatch(/\d/);
    expect(values).not.toMatch(/'safety'/);
  });
});

describe('адреса и публичный API', () => {
  it('страницы отдельных приложений ведут на список, постоянно', async () => {
    const config = require(join(process.cwd(), 'next.config.js')) as {
      redirects: () => Promise<Array<{ source: string; destination: string; permanent?: boolean }>>;
    };
    const rule = (await config.redirects()).find((r) => r.source === '/ai-tools/:slug');
    expect(rule).toMatchObject({ destination: '/ai-tools', permanent: true });
  });

  it('GET /api/tools: порядок назван, рейтинга и счётчика попаданий нет', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { GET } = await import('@/app/api/tools/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/tools?sort=trending'));
    const body = (await res.json()) as { order?: string };
    expect(body.order).toBe('по разделу, внутри — по имени');
    const listSql = String(query.mock.calls[0][0]);
    expect(listSql).toMatch(/ORDER BY category, name/);
    expect(listSql).not.toMatch(/use_count|rating/);
  });

  it('POST /api/tools/[slug]: отказ счётчика щелчков назван в логе, ответ прежний', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57P01' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/tools/[slug]/route');
    const res = await POST(new NextRequest('https://vedarai.ru/api/tools/wikiloc', { method: 'POST' }), { params: Promise.resolve({ slug: 'wikiloc' }) });
    expect(await res.json()).toEqual({ ok: true });
    expect(err.mock.calls.some((c) => String(c[0]).includes('счётчик щелчков'))).toBe(true);
    err.mockRestore();
  });
});
