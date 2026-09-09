/**
 * tests/unit/scout-sources-single-owner.test.ts
 *
 * У состава разведки один хозяин, а не копия в каждом читателе.
 *
 * ── Что случилось (08.09) ──────────────────────────────────────────────────
 *
 * Состав жил в `scout-digest.ts`, а раннеру подбора он нужен затем, чтобы не
 * предлагать уже имеющееся. Импортировать дайджест раннер не может — тот тянет
 * пул БД, которой у раннера нет, — и потому в раннере лежала КОПИЯ списка.
 *
 * Копия разошлась с оригиналом за сутки. 07.09 в разведку добавили четыре
 * государственных канала, в копию их не внесли — и прогон подбора 4 честно
 * предложил три из них заново, а перепись честно назвала их живыми. Отчёт
 * вышел «нашли восемь новых источников», из которых три уже стояли в составе.
 *
 * Соврал не подбор и не перепись: каждый ответил на свой вопрос верно. Соврал
 * СТЫК — место, где два списка считались одним.
 *
 * ── Почему это §12, а не невнимательность ──────────────────────────────────
 *
 * Список, поддерживаемый в двух местах, будет расходиться всегда: обновляют
 * тот, с которым сейчас работают. «Быть внимательнее» тут не работает, потому
 * что вторая копия не видна тому, кто правит первую.
 *
 * Отсюда правка: состав вынесен в чистый модуль (ни пула, ни сети), и его
 * импортируют оба читателя. Копии больше нет — есть один список.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RSS_SOURCES } from '@/lib/agents/scout-sources';
import { filterCandidates } from '@/scripts/source-discovery-runner';

const RUNNER = readFileSync(join(process.cwd(), 'scripts/source-discovery-runner.ts'), 'utf-8');
const DIGEST = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');
const SOURCES = readFileSync(join(process.cwd(), 'lib/agents/scout-sources.ts'), 'utf-8');

describe('состав живёт в одном месте', () => {
  it('модуль состава чист: ни пула, ни сети — иначе раннер его не импортирует', () => {
    // Ровно из-за этого и завелась копия. Вернётся зависимость — вернётся и она.
    expect(SOURCES).not.toMatch(/from '@\/lib\/db-pool'/);
    expect(SOURCES).not.toMatch(/\bfetch\s*\(/);
  });

  it('дайджест берёт состав оттуда же, а не держит свой', () => {
    expect(DIGEST).toMatch(/from '@\/lib\/agents\/scout-sources'/);
    expect(DIGEST).not.toMatch(/export const RSS_SOURCES: ScoutSource\[\] = \[/);
  });

  it('раннер выводит список известного из состава, а не переписывает', () => {
    expect(RUNNER).toMatch(/const EXISTING_URLS = RSS_SOURCES\.map/);
  });

  it('копии адресов в раннере не осталось', () => {
    // Признак прежней копии — адреса источников прямо в файле раннера.
    expect(RUNNER).not.toMatch(/simonwillison\.net/);
    expect(RUNNER).not.toMatch(/t\.me\/s\/ru_rst/);
  });
});

describe('уже стоящее в разведке не предлагается заново', () => {
  const already = RSS_SOURCES.slice(0, 12).map(s => s.url);

  it('каждый адрес состава отсекается дедупом', () => {
    const r = filterCandidates({
      candidates: already.map(url => ({
        name: 'X',
        kind: url.includes('t.me/') ? 'telegram' : 'rss',
        area: 'region',
        why: 'причина',
        url,
      })),
    });
    expect(r.kept, `просочились: ${r.kept.map(k => k.url).join(', ')}`).toHaveLength(0);
    expect(r.dropped.every(d => /уже стоит в разведке/.test(d.why))).toBe(true);
  });

  it('те самые три канала из прогона 4 больше не проходят', () => {
    // Дословный случай: их добавили 07.09, копия о них не знала.
    const r = filterCandidates({
      candidates: [
        'https://t.me/s/mchs_official',
        'https://t.me/s/government_rus',
        'https://t.me/s/Mintrans_Russia',
      ].map(url => ({ name: 'X', kind: 'telegram', area: 'region', why: 'w', url })),
    });
    expect(r.kept).toHaveLength(0);
  });

  it('дедуп не зависит от схемы и хвостового слэша', () => {
    // Иначе тот же источник вернётся под слегка другим написанием.
    const one = RSS_SOURCES[0].url.replace(/^https/, 'http').replace(/\/?$/, '/');
    const r = filterCandidates({ candidates: [{ name: 'X', kind: 'rss', area: 'region', why: 'w', url: one }] });
    expect(r.kept).toHaveLength(0);
  });
});
