/**
 * Импортёр операторов не заводит партнёра без имени.
 *
 * 22.08 владелец нашёл в админке партнёра «В031-00161-77/01529555» и не понял,
 * откуда тот взялся. Это номер в федеральном реестре туроператоров, который
 * разбор каталога visitkamchatka.ru принял за НАЗВАНИЕ компании. Рядом лёг и
 * «сайт» — ссылка на карточку в госреестре `ev.economy.gov.ru/lk_exp/...`.
 *
 * Прежняя проверка отсекала форму «РТО 12345», но не сам номер: в нём есть
 * буква «В», и условия «есть хоть одна буква» хватало. То есть проверка
 * перечисляла ЗНАКОМЫЕ ей случаи вместо того, чтобы назвать правило.
 *
 * Правило по смыслу: у компании есть слово — буквенная цепочка хотя бы из
 * трёх букв. Оно не требует знать заранее, как выглядит очередной номер.
 *
 * Проверяется через разбор markdown, а не приватную функцию: сторож должен
 * держать поведение импортёра, а не его внутреннее устройство.
 */
import { describe, it, expect } from 'vitest';
import { parseOperatorsMarkdown } from '@/lib/services/ingest/visitkamchatka-operators';

const card = (title: string, body = '') =>
  `## ${title}\n\nтелефон +7(962)217-56-56\n${body}\n`;

describe('название оператора', () => {
  it('реестровый номер не становится партнёром', () => {
    const got = parseOperatorsMarkdown(card('В031-00161-77/01529555'));
    expect(got.map((o) => o.name)).toEqual([]);
  });

  it('прежняя форма «РТО 12345» тоже не проходит', () => {
    expect(parseOperatorsMarkdown(card('РТО 012345'))).toEqual([]);
  });

  it('настоящие названия проходят', () => {
    for (const name of ['Край путешествий', 'Kamchatka Land', 'ИП Иванов', 'АО «Три вулкана»']) {
      const got = parseOperatorsMarkdown(card(name));
      expect(got.map((o) => o.name), `${name} должно проходить`).toEqual([name]);
    }
  });
});

describe('сайт оператора', () => {
  it('ссылка на федеральный реестр не идёт в поле сайта', () => {
    // Иначе турист, нажав «сайт», попадает в чужой личный кабинет госсистемы.
    const got = parseOperatorsMarkdown(
      card('Край путешествий', 'https://ev.economy.gov.ru/lk_exp/registry/to/1b2c3d'),
    );
    expect(got[0]?.website).toBeUndefined();
  });

  it('настоящий сайт проходит', () => {
    const got = parseOperatorsMarkdown(card('Край путешествий', 'https://kray-puteshestviy.ru/'));
    expect(got[0]?.website).toBe('https://kray-puteshestviy.ru/');
  });
});
