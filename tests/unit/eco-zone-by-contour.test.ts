/**
 * Режим мест, поставленный ILIKE 169/170, — по контуру территории (1274;
 * 15.10, §0 «честность»).
 *
 * Десяти местам род территории и пропуск ставил ILIKE: «кроноцк» —
 * заповедник, «unesco» — ЮНЕСКО, «налычево» или «быстрин» в зоне — парк.
 * Сверка по контурам OSM (Overpass is_in, пробы 950–952) нашла чужой род у
 * пяти и мёртвый адрес разрешения у девяти: kronoki.ru/visit/ — 404,
 * kamchatkaparks.ru не отвечает.
 *
 * Миграция — артефакт, её текст судится по смыслу (решение владельца 13.10):
 *   1. всякая запись режима стоит на условии состояния 169/170 — правила,
 *      записанные человеком, не перезаписываются;
 *   2. адрес заявки у мест заповедника — тот же, что у кода
 *      (KRONOKI_REQUESTS.url), а не своя копия;
 *   3. мёртвые адреса не записывает ни одна миграция после 1273 (запрет);
 *   4. у мест вне охраняемых территорий режим — «не записано» (NULL), а не
 *      выдуманное «нет»;
 *   5. справка о Кроноцком озере не повторяет снятые выдумки, очерк уходит
 *      в архив, а не удаляется.
 * Выполнение проверено на PostgreSQL сценой: пять мест заповедника, заказник,
 * четыре «не записано», переписанное озеро; правленное рукой место и повтор —
 * без изменений.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KRONOKI_REQUESTS } from '@/lib/safety/park-permit';

const DIR = join(process.cwd(), 'migrations');
const noComments = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const M = noComments(readFileSync(join(DIR, '1274_eco_zone_by_contour_ilike_places.sql'), 'utf-8'));
const DEAD = ['https://kronoki.ru/visit/', 'https://kamchatkaparks.ru/'];

/** UPDATE places, меняющие режим места: SET … WHERE … ; */
const regimeUpdates = [...M.matchAll(/UPDATE places\s+SET([\s\S]*?)WHERE([\s\S]*?);/g)]
  .filter((m) => /eco_zone\s*=|eco_permit_required\s*=|eco_permit_url\s*=/.test(m[1]));

describe('1274: режим по контуру', () => {
  it('перепись нашла записи режима (смотрящая не туда не выглядит успешной)', () => {
    expect(regimeUpdates.length).toBeGreaterThanOrEqual(4);
  });

  it('каждая запись режима — только поверх состояния 169/170, правила человека не трогаются', () => {
    for (const [, , where] of regimeUpdates) {
      expect(where).toMatch(/eco_rules IS NULL/);
      expect(where).toMatch(/eco_rules_withdrawn IS NOT NULL/);
    }
  });

  it('адрес заявки заповедника — тот же, что у кода', () => {
    const reserve = regimeUpdates.find(([, set]) => /eco_zone = 'federal_reserve'/.test(set));
    expect(reserve, 'запись мест заповедника').toBeDefined();
    expect(reserve![1]).toContain(`eco_permit_url = '${KRONOKI_REQUESTS.url}'`);
  });

  it('вне охраняемых территорий — «не записано», а не «нет»', () => {
    const outside = regimeUpdates.filter(([, set]) => /eco_zone = NULL/.test(set));
    expect(outside.length).toBeGreaterThanOrEqual(1);
    expect(M).not.toMatch(/eco_zone = 'none'/);
    for (const [, set] of outside) expect(set).toMatch(/eco_permit_required = NULL/);
  });

  it('Кроноцкое озеро: справка без нерпы и кальдеры, очерк — в архив', () => {
    const lake = M.slice(M.indexOf("description_withdrawn = COALESCE(description_withdrawn, description)"));
    const text = lake.slice(lake.indexOf('description ='), lake.indexOf('source_name ='));
    expect(text).not.toMatch(/нерп(а|ы|у|ой|ам|ами)?(?![а-яё])/i);
    expect(text).not.toMatch(/скован\S* кальдер/i);
    expect(text).toMatch(/лавовой запрудой/);
    expect(M).not.toMatch(/DELETE FROM places/);
  });
});

describe('мёртвые адреса разрешения больше не записываются', () => {
  it('ни одна миграция после 1273 не ставит kronoki.ru/visit/ и kamchatkaparks.ru в eco_permit_url', () => {
    const later = readdirSync(DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f) && Number(f.split('_')[0]) > 1273);
    expect(later.length).toBeGreaterThan(0);
    for (const f of later) {
      const body = noComments(readFileSync(join(DIR, f), 'utf-8'));
      // Записью считается SET … (до WHERE) и INSERT; сравнение в WHERE —
      // это условие «было мёртвым», как в самой 1274, и оно разрешено.
      const sets = [...body.matchAll(/\bSET\b([\s\S]*?)(?:\bWHERE\b|;)/g)].map((m) => m[1]);
      const inserts = [...body.matchAll(/INSERT INTO places\b[\s\S]*?;/g)].map((m) => m[0]);
      for (const url of DEAD) {
        for (const s of sets) expect(s, f).not.toContain(`'${url}'`);
        for (const s of inserts) expect(s, f).not.toContain(`'${url}'`);
      }
    }
  });
});
