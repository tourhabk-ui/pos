import { describe, it, expect } from 'vitest';
import { classifyMchsItem, mchs_zones } from '@/lib/services/seismic-parser';

// Реальный бюллетень МЧС Камчатка (2 июля), который раньше молча отбрасывался —
// ни цунами, ни шторм, ни паводок, ни пожар: 4 категории classifyMchsItem не
// покрывали "воздержаться от восхождения на вулкан" вообще.
const MUTNOVSKY_TITLE = 'Камчатским туристам настоятельно рекомендуют воздержаться от восхождения на Мутновский вулкан';
const MUTNOVSKY_DESC = `На Камчатке состоялось внеочередное заседание Камчатского филиала Российского
экспертного совета по прогнозу землетрясений, оценке сейсмической опасности и риска о сейсмической
и вулканической опасности в Камчатском крае. Ученые оценили опасность вулкана Мутновского.
Утром 2 июля был зафиксирован газопепловый выброс. В постройке вулкана происходят многочисленные
землетрясения с магнитудами до 3. В такой активной геодинамической обстановке реальную опасность
при посещении вулкана представляют оползни и обвалы. Спасатели призывают гостей и жителей полуострова
не предпринимать самостоятельных путешествий к вулкану Мутновскому и тем более не совершать на него
восхождений. Руководителям туристических групп также рекомендовано воздержаться от посещения вулкана.`;

describe('classifyMchsItem — volcanic hazard advisories (regression: Mutnovsky 2026-07-02)', () => {
  it('classifies the real Mutnovsky "avoid climbing" bulletin instead of dropping it', () => {
    const event = classifyMchsItem('mchs/test-1', MUTNOVSKY_TITLE, MUTNOVSKY_DESC, '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/1');
    expect(event).not.toBeNull();
    expect(event!.alert_type).toBe('volcanic_eruption');
  });

  it('assigns severity 2 (drives recommender_status=red) for an explicit avoid-recommendation', () => {
    const event = classifyMchsItem('mchs/test-2', MUTNOVSKY_TITLE, MUTNOVSKY_DESC, '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/2');
    expect(event!.severity).toBe(2);
  });

  it('resolves the affected zone by volcano name, not just administrative district', () => {
    const event = classifyMchsItem('mchs/test-3', MUTNOVSKY_TITLE, MUTNOVSKY_DESC, '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/3');
    expect(event!.affected_zones).toEqual(['avachinsky']);
  });

  it('classifies a volcanic-activity bulletin without an explicit avoid-recommendation at lower severity', () => {
    const event = classifyMchsItem(
      'mchs/test-4',
      'Пепловый выброс на вулкане Толбачик',
      'Зафиксирован пепловый выброс на вулкане Толбачик, пеплопад в районе наблюдений.',
      '2026-07-02T05:00:00Z',
      'https://41.mchs.gov.ru/item/4',
    );
    expect(event).not.toBeNull();
    expect(event!.severity).toBe(1);
  });

  it('still returns null for content matching none of the known categories', () => {
    const event = classifyMchsItem('mchs/test-5', 'Открытие нового моста через реку Авача', 'Сегодня состоялось торжественное открытие моста.', '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/5');
    expect(event).toBeNull();
  });

  it('still classifies the pre-existing categories unchanged (tsunami/flood/fire)', () => {
    const tsunami = classifyMchsItem('mchs/t', 'Угроза цунами', 'Объявлена угроза цунами на побережье.', '2026-07-02T05:00:00Z', 'https://x');
    expect(tsunami!.alert_type).toBe('tsunami_warning');
    expect(tsunami!.severity).toBe(3);

    const flood = classifyMchsItem('mchs/f', 'Паводок на реке Камчатка', 'Ожидается подъём уровня воды на реках.', '2026-07-02T05:00:00Z', 'https://x');
    expect(flood!.alert_type).toBe('flood');

    const fire = classifyMchsItem('mchs/p', 'Особый противопожарный режим', 'Введён особый противопожарный режим.', '2026-07-02T05:00:00Z', 'https://x');
    expect(fire!.alert_type).toBe('fire_danger');
  });
});

describe('mchs_zones', () => {
  it('matches a volcano name before falling back to district regex', () => {
    expect(mchs_zones('опасность вулкана Мутновского')).toEqual(['avachinsky']);
    expect(mchs_zones('вулкан Толбачик, пепловый выброс')).toEqual(['northern']);
    expect(mchs_zones('вулкан Карымский активизировался')).toEqual(['eastern']);
  });

  it('falls back to district-name matching when no volcano is named', () => {
    expect(mchs_zones('паводок в Усть-Камчатском районе')).toEqual(['northern']);
  });

  it('defaults to avachinsky when neither volcano nor known district is mentioned', () => {
    expect(mchs_zones('погодное предупреждение по краю')).toEqual(['avachinsky']);
  });
});
