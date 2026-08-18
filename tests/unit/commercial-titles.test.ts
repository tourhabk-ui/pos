/**
 * Запись, чьё имя продаёт, а не ведёт.
 *
 * Владелец 18.08: «есть по названиям коммерция, а не маршрут». `twins.ts`
 * убирает «маршруты», которые на самом деле места; `title-dupes` ловит
 * повторы; третьего класса не ловил никто — «Джип-тур на Толбачик» лежит в
 * таблице маршрутов наравне с тропами.
 *
 * Главное в правиле — не что оно ловит, а чего НЕ трогает: линию, по которой
 * кто-то прошёл, нельзя выбросить из-за слова в заголовке.
 */
import { describe, it, expect } from 'vitest';
import { commercialTitleMarker, isCommercialRecord } from '@/lib/routes/commercial-titles';

const empty = { trackPoints: 0, waypoints: 0 };

describe('коммерческое имя опознаётся', () => {
  it('прямые названия продукта', () => {
    for (const t of [
      'Джип-тур на Толбачик',
      'Вертолётная экскурсия в Долину гейзеров',
      'Экскурсия к Мутновскому',
      'Тур выходного дня',
      'Фототур «Медведи Курильского озера»',
      'Трансфер до Авачинского перевала',
    ]) {
      expect(commercialTitleMarker(t), t).not.toBeNull();
    }
  });

  it('опознанное названо своим словом — разбор идёт по причине', () => {
    expect(commercialTitleMarker('Вертолётная экскурсия')?.marker).toBeTruthy();
    expect(commercialTitleMarker('Джип-тур на Толбачик')?.marker).toBeTruthy();
  });
});

describe('способ прохождения и длительность коммерцией не считаются', () => {
  it('как идут — не то же, что что продают', () => {
    for (const t of [
      'Горный массив Вачкажец (лыжный)',
      'Горный массив Вачкажец (снегоходный)',
      'Восхождение на Авачинский вулкан',
      'Сплав по реке Быстрая',
      'Поход к Налычевским источникам',
    ]) {
      expect(commercialTitleMarker(t), t).toBeNull();
    }
  });

  it('однодневность — свойство маршрута, а не прайса', () => {
    // Мерить коммерцию длительностью значило бы записать в прайс половину
    // троп края.
    expect(commercialTitleMarker('Однодневный поход к Авачинскому вулкану')).toBeNull();
    expect(commercialTitleMarker('Толбачик за 3 дня')).toBeNull();
  });

  it('слово «тур» внутри другого слова не считается', () => {
    // «Турбаза» — место, «Турпан» — птица.
    expect(commercialTitleMarker('Турбаза Апача')).toBeNull();
    expect(commercialTitleMarker('Озеро Турпанье')).toBeNull();
  });
});

describe('признак составной: имя И пустота вместо пути', () => {
  it('коммерческое имя без пути — кандидат', () => {
    expect(isCommercialRecord('Джип-тур на Толбачик', empty)).not.toBeNull();
  });

  it('со снятым треком остаётся маршрутом, как бы ни назвали', () => {
    // Линию, по которой кто-то прошёл, нельзя выбросить из-за слова в
    // заголовке.
    expect(isCommercialRecord('Джип-тур на Толбачик', { trackPoints: 400, waypoints: 0 })).toBeNull();
  });

  it('с путевыми точками — тоже маршрут', () => {
    expect(isCommercialRecord('Экскурсия к Мутновскому', { trackPoints: 0, waypoints: 5 })).toBeNull();
  });

  it('обычное имя без пути коммерцией не объявляется', () => {
    // Пустая запись — отдельная беда, и лечится она не этим правилом.
    expect(isCommercialRecord('Вулкан Кизимен', empty)).toBeNull();
  });

  it('пустое имя не роняет разбор', () => {
    expect(commercialTitleMarker(null)).toBeNull();
    expect(commercialTitleMarker('')).toBeNull();
    expect(isCommercialRecord(undefined, empty)).toBeNull();
  });
});
