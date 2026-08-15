/**
 * Восстановление (план FCN, этап 6): честные состояния вместо тревог.
 *
 * Главный инвариант — тот, ради которого модуль вообще отдельный:
 * **«вернитесь к линии» говорится только про снятый трек**. У наброска
 * линия построена прямыми между точками (миграция 168), и звать на неё —
 * звать в каньон. Там другое состояние, другие слова и никакого возврата.
 *
 * Рядом: устаревший фикс не превращается в «вы сбились» (мы не знаем, где
 * человек, и обязаны сказать именно это); при расхождении данных цифр нет
 * вовсе; карточка не модальная и не прячет приборы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryState, type RecoveryInput } from '@/lib/on-route/recovery';
import type { FixInfo } from '@/lib/on-route/fix-quality';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const LIVE_FIX: FixInfo = { state: 'live', ageSeconds: 3, accuracyM: 8 };
const DEAD_FIX: FixInfo = { state: 'dead', ageSeconds: 900, accuracyM: 20 };

function input(over: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    fidelity: 'surveyed',
    hasTrack: true,
    userOffTrack: false,
    offTrackKm: null,
    dataConflict: false,
    fix: LIVE_FIX,
    mapSaved: true,
    offline: false,
    ...over,
  };
}

describe('«вернуться к линии» — только у снятого трека', () => {
  it('на снятом треке зовём обратно и называем расстояние', () => {
    const s = recoveryState(input({ userOffTrack: true, offTrackKm: 0.07 }));
    expect(s.kind).toBe('off_track');
    expect(s.title).toMatch(/в стороне от линии/);
    expect(s.title).toMatch(/70 м/);
    expect(s.text).toMatch(/Вернитесь к отмеченной линии/);
  });

  it('на наброске возврата НЕТ — и это сказано словами', () => {
    const s = recoveryState(input({ fidelity: 'sketch', userOffTrack: true, offTrackKm: 0.5 }));
    expect(s.kind).toBe('off_sketch');
    expect(s.text).not.toMatch(/вернитесь|вернуться/i);
    expect(s.text).toMatch(/ориентир, а не тропа/);
  });

  it('линия неизвестного происхождения тоже не зовёт обратно', () => {
    const s = recoveryState(input({ fidelity: 'unknown', userOffTrack: true, offTrackKm: 0.3 }));
    expect(s.kind).toBe('off_sketch');
    expect(s.text).not.toMatch(/вернитесь|вернуться/i);
  });

  it('ни одно состояние не советует идти по прямой через рельеф', () => {
    const cases: RecoveryInput[] = [
      input({ userOffTrack: true, offTrackKm: 0.1 }),
      input({ fidelity: 'sketch', userOffTrack: true, offTrackKm: 0.1 }),
      input({ fix: DEAD_FIX }),
      input({ dataConflict: true }),
      input({ mapSaved: false }),
    ];
    for (const c of cases) {
      const t = recoveryState(c).text;
      expect(t).not.toMatch(/идите по прямой(?! через)/i);
    }
    // На снятом треке прямая прямо запрещена словами.
    expect(recoveryState(input({ userOffTrack: true, offTrackKm: 0.1 })).text)
      .toMatch(/Не идите по прямой через рельеф/);
  });
});

describe('устаревший фикс — не тревога «вы сбились»', () => {
  it('мёртвый фикс говорит о сигнале, а не о положении человека', () => {
    const s = recoveryState(input({ fix: DEAD_FIX, userOffTrack: true, offTrackKm: 2 }));
    expect(s.kind).toBe('stale_fix');
    expect(s.title).not.toMatch(/сбились|в стороне/i);
    expect(s.text).toMatch(/не обновляются/);
  });

  it('без фикса вовсе — «положение неизвестно»', () => {
    const s = recoveryState(input({ fix: { state: 'none', ageSeconds: null, accuracyM: null } }));
    expect(s.kind).toBe('stale_fix');
    expect(s.title).toMatch(/неизвестно/);
  });
});

describe('расхождение данных важнее всего остального', () => {
  it('перебивает и отход, и отсутствие карты', () => {
    const s = recoveryState(input({ dataConflict: true, userOffTrack: true, mapSaved: false }));
    expect(s.kind).toBe('data_conflict');
    expect(s.dismissible).toBe(false);
    expect(s.text).toMatch(/не показываем/);
  });
});

describe('карта в телефоне', () => {
  it('без карты и без связи — честно про то, что осталось', () => {
    const s = recoveryState(input({ mapSaved: false, offline: true }));
    expect(s.kind).toBe('no_offline_map');
    expect(s.text).toMatch(/точки маршрута, компас и координаты/);
  });

  it('без карты, но при связи — предложение сохранить, тон спокойный', () => {
    const s = recoveryState(input({ mapSaved: false, offline: false }));
    expect(s.kind).toBe('no_offline_map');
    expect(s.tone).toBe('info');
    expect(s.primary?.kind).toBe('open_pack');
  });

  it('всё в порядке — карточки нет', () => {
    expect(recoveryState(input()).kind).toBe('none');
  });
});

describe('карточка — смена задачи, а не модальное окно', () => {
  const card = read('components/field/RecoveryCard.tsx');
  const client = read('app/planning/_PlanningClient.tsx');

  it('не оверлей и не фиксированная поверх экрана', () => {
    expect(card).not.toMatch(/fixed inset-0|position:\s*'fixed'/);
  });

  it('«продолжить намеренно» сворачивает, но состояние остаётся названным', () => {
    expect(card).toMatch(/Продолжить намеренно/);
    // В свёрнутом виде заголовок состояния всё ещё печатается.
    expect(card).toMatch(/muted[\s\S]{0,400}state\.title/);
  });

  it('приглушение привязано к роду состояния — новое покажется заново', () => {
    expect(client).toMatch(/mutedRecovery === recovery\.kind/);
  });

  it('экран берёт состояние у движка, а не решает сам', () => {
    expect(client).toMatch(/recoveryState\(\{/);
    expect(client).toMatch(/<RecoveryCard/);
  });
});

describe('SOS полевого режима — общий компонент', () => {
  it('своей кнопки в кокпите не осталось', () => {
    const client = read('app/planning/_PlanningClient.tsx');
    expect(client).toMatch(/<EmergencyAction variant="field"/);
    // Сырой tel:112 в сетке действий убран (в листе «Группа» ссылка на
    // телефон допустима — это не кнопка SOS, а номер).
    expect(client).not.toMatch(/rounded-xl font-bold text-xl[\s\S]{0,120}SOS/);
  });

  it('вариант field живёт в единственной реализации SOS', () => {
    const action = read('components/shared/EmergencyAction.tsx');
    expect(action).toMatch(/'header' \| 'tab' \| 'field'/);
    expect(action).toMatch(/variant === 'field'/);
    // Офлайн-ветка одна на все варианты.
    expect(action).toMatch(/navigator\.onLine === false/);
  });
});
