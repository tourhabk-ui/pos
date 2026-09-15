/**
 * Сторож привязки дорожных предупреждений.
 *
 * Владелец 15.09 на карточке «Раздолья Камчатки»: предупреждение «Вилючинский
 * перевал — проезд по пропускам» висело у купальни за шестьдесят километров,
 * потому что дорожные ограничения раскладывались ЗОНОЙ — на сотни километров.
 * Решение: «30 км от вилючинского вулкана достаточно».
 *
 * Сторож держит две вещи, которыми эта привязка может соврать:
 *   — привязать к ЧУЖОЙ точке (угадать там, где имя неоднозначно);
 *   — потерять радиус, вернув предупреждение на всю зону незаметно.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAnchorIndex, matchAlertAnchor, landmarkStem, ROAD_ALERT_RADIUS_KM,
  type AnchorPlace,
} from '@/lib/safety/alert-anchor';
import { volcanoStem } from '@/lib/services/safety/volcano-match';

const VILYUCHIK: AnchorPlace = { id: 'v1', name: 'Вулкан Вилючинский', lat: 52.69, lng: 158.28 };
const MUTNOVSKY: AnchorPlace = { id: 'm1', name: 'Вулкан Мутновский', lat: 52.45, lng: 158.20 };
const RAZDOLIE: AnchorPlace = { id: 'r1', name: 'Раздолье Камчатки', lat: 53.18, lng: 158.05 };

describe('привязка дорожного предупреждения к точке', () => {
  it('«Вилючинский перевал» находит Вилючинский вулкан — тот самый случай владельца', () => {
    const index = buildAnchorIndex([VILYUCHIK, MUTNOVSKY, RAZDOLIE]);
    const m = matchAlertAnchor(index, 'Закрыт проезд через Вилючинский перевал — по пропускам');
    expect(m.kind).toBe('matched');
    if (m.kind === 'matched') expect(m.place.id).toBe('v1');
  });

  it('несколько точек с одной основой — отказ, а не выбор наугад', () => {
    // Привязать к чужой точке хуже, чем не привязать: человек примет
    // решение по координате, которую мы угадали (§4.1, разбор 23.08).
    const index = buildAnchorIndex([
      VILYUCHIK,
      { id: 'v2', name: 'Вилючинская бухта', lat: 52.90, lng: 158.40 },
    ]);
    const m = matchAlertAnchor(index, 'Ограничение проезда: Вилючинский перевал');
    expect(m.kind).toBe('ambiguous');
  });

  it('точки нет в каталоге — «нет», а не привязка к похожему', () => {
    const index = buildAnchorIndex([VILYUCHIK, MUTNOVSKY]);
    const m = matchAlertAnchor(index, 'Закрыт проезд на Ганалы');
    expect(m.kind).toBe('none');
  });

  it('однозначное совпадение выигрывает у неоднозначного, а не наоборот', () => {
    // «Мутновский перевал» однозначен, «Вилючинский» — нет. Отдать
    // ambiguous раньше значило бы потерять верный ответ.
    const index = buildAnchorIndex([
      VILYUCHIK,
      { id: 'v2', name: 'Вилючинская бухта', lat: 52.90, lng: 158.40 },
      MUTNOVSKY,
    ]);
    const m = matchAlertAnchor(index, 'Вилючинский и Мутновский перевал закрыты');
    expect(m.kind).toBe('matched');
  });

  it('привязка идёт по заголовку — короткая основа не цепляет что попало', () => {
    const index = buildAnchorIndex([{ id: 'x', name: 'Река Ава', lat: 53, lng: 158 }]);
    // Основа «ав» короче порога: иначе она совпала бы с любым текстом,
    // где встретится это сочетание, и привязала бы предупреждение наугад.
    expect(landmarkStem('Река Ава').length).toBeLessThan(4);
    expect(matchAlertAnchor(index, 'Авария на трассе').kind).toBe('none');
  });
});

describe('словари родовых слов не сливаются', () => {
  it('«перевал» срезается у ландшафта и НЕ срезается у вулканов', () => {
    // Слить списки значило бы схлопнуть «Вилючинский перевал» и «Вулкан
    // Вилючинский» в одну основу ДЛЯ KVERT — и авиационный код уехал бы с
    // конуса на перевал.
    expect(landmarkStem('Вилючинский перевал')).toBe(landmarkStem('Вулкан Вилючинский'));
    expect(volcanoStem('Вилючинский перевал')).not.toBe(volcanoStem('Вулкан Вилючинский'));
  });

  it('нормализация имени одна на обе области', () => {
    const src = readFileSync(join(process.cwd(), 'lib/safety/alert-anchor.ts'), 'utf8');
    // Своей копии токенизации здесь быть не должно: две нормализации одного
    // имени разойдутся при первой правке.
    expect(src).toContain("from '@/lib/services/safety/volcano-match'");
    expect(src).not.toMatch(/ADJ_ENDINGS|function stemWord/);
  });
});

describe('радиус доезжает до SQL', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf8');

  it('road_closure судится радиусом, а не зоной', () => {
    expect(route).toMatch(/alert_type IN \('fire_danger', 'road_closure'\)/);
  });

  it('радиус берётся из константы, а не вписан числом в запрос', () => {
    // Второе значение радиуса в SQL — это второе правило, и оно разойдётся
    // с первым при следующей правке.
    expect(route).toContain('${ROAD_ALERT_RADIUS_KM}');
    expect(ROAD_ALERT_RADIUS_KM).toBe(30);
  });

  it('привязка идёт ДО раскладки тревог по точкам', () => {
    const anchorAt = route.indexOf('anchorRoadAlerts()');
    const spreadAt = route.indexOf('updateRealTimeStatus(), dispatchPushAlerts()');
    expect(anchorAt).toBeGreaterThan(-1);
    // Иначе координаты появятся уже после раскладки, и предупреждение уйдёт
    // по зоне ещё на один прогон.
    expect(anchorAt).toBeLessThan(spreadAt);
  });

  it('отказ привязки виден в ответе, а не выдаётся за ноль привязок', () => {
    expect(route).toMatch(/road_anchors: roadAnchors \?\? null/);
    expect(route).toMatch(/каталог мест пуст/);
  });
});
