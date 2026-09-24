// @vitest-environment node
/**
 * Сводка КФ ФИЦ ЕГС РАН о вулканах разбирается, и незнакомое остаётся незнакомым.
 *
 * Фикстура — НАСТОЯЩАЯ страница `https://www.emsd.ru/vmon/`, снятая владельцем
 * 21.09 (сводка за 20.09), целиком, без правки вёрстки. Почищенная фикстура
 * доказывала бы, что парсер справляется с тем, что я сам же и причесал.
 *
 * Главное, что здесь держится, — НЕ количество разобранных строк, а отказ
 * угадывать: код «Белый» в авиационный набор не входит, в легенде самой
 * сводки (четыре цвета) его тоже нет, и приводить его к зелёному или к «не
 * присвоен» нельзя. Зелёный при неработающем мониторинге — худший исход из
 * возможных: человек читает «спокоен» там, где обсерватория сказала «не вижу».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseVmon,
  parseVmonDate,
  elevatedRows,
  unknownColorRows,
  EMSD_VMON_URL,
} from '@/lib/services/safety/emsd-vmon';

const HTML = readFileSync(
  join(process.cwd(), 'tests/fixtures/safety/emsd-vmon-2026-09-20.html'),
  'utf-8',
);
const BULLETIN = parseVmon(HTML);

describe('сводка разбирается целиком', () => {
  it('разобрана без жалоб', () => {
    expect(BULLETIN.problems, `парсер пожаловался: ${BULLETIN.problems.join('; ')}`).toEqual([]);
  });

  it('вулканы найдены, и шапка таблицы в них не попала', () => {
    expect(BULLETIN.rows.length).toBe(15);
    expect(BULLETIN.rows.map((r) => r.nameRu)).not.toContain('Вулканы');
  });

  it('дата — за какие сутки наблюдения, а не когда прочитали', () => {
    expect(BULLETIN.observedDate).toBe('2026-09-20');
  });

  it('имена разделены на русское и латинское', () => {
    const tolbachik = BULLETIN.rows.find((r) => r.nameEn === 'Plosky Tolbachik');
    // Два слова с каждой стороны — делить по пробелу было бы неверно.
    expect(tolbachik?.nameRu).toBe('Плоский Толбачик');
  });

  it('вулканы сопоставлены с общим словарём, а не со своим', () => {
    const sheveluch = BULLETIN.rows.find((r) => r.nameRu === 'Шивелуч');
    expect(sheveluch?.nameSlug).toBe('sheveluch');
  });
});

describe('коды читаются, и повышенные видны', () => {
  it('Шивелуч оранжевый', () => {
    expect(BULLETIN.rows.find((r) => r.nameRu === 'Шивелуч')?.color).toBe('orange');
  });

  it('Мутновский и Горелый жёлтые — это пешие маршруты', () => {
    expect(BULLETIN.rows.find((r) => r.nameRu === 'Мутновский')?.color).toBe('yellow');
    expect(BULLETIN.rows.find((r) => r.nameRu === 'Горелый')?.color).toBe('yellow');
  });

  it('повышенные идут по убыванию опасности', () => {
    const names = elevatedRows(BULLETIN).map((r) => r.nameRu);
    expect(names[0]).toBe('Шивелуч');
    expect(names).toContain('Мутновский');
    expect(names).toContain('Горелый');
    expect(names, 'спокойный вулкан попал в повышенные').not.toContain('Ключевской');
  });
});

describe('незнакомый код остаётся незнакомым', () => {
  const white = BULLETIN.rows.filter((r) => r.colorRaw === 'Белый');

  it('белые вулканы в снимке есть — иначе проверять нечего', () => {
    // Ноль при нулевом входе — отказ, а не успех: исчезни «Белый» из
    // фикстуры, и весь блок ниже стал бы зелёным на пустоте.
    expect(white.length).toBe(3);
  });

  it('цвет не назначен', () => {
    for (const r of white) {
      expect(r.color, `${r.nameRu}: «Белый» приведён к коду, которого источник не давал`).toBeNull();
    }
  });

  it('ЗЕЛЁНЫМ он не становится ни при каких условиях', () => {
    // Отдельной проверкой, а не следствием предыдущей: именно этот исход
    // опаснее всех прочих вместе взятых.
    for (const r of white) {
      expect(r.color).not.toBe('green');
    }
  });

  it('причина названа словами, а не оставлена пустой', () => {
    for (const r of white) {
      expect(r.colorUnknownReason).toBeTruthy();
      expect(String(r.colorUnknownReason).length).toBeGreaterThan(20);
    }
  });

  it('дословная строка кода сохранена — по ней и разбирать', () => {
    expect(white.map((r) => r.nameRu).sort()).toEqual(['Алаид', 'Карымский', 'Эбеко']);
  });

  it('неразобранные НЕ попадают в повышенные', () => {
    const elevated = new Set(elevatedRows(BULLETIN).map((r) => r.nameRu));
    for (const r of white) {
      expect(elevated.has(r.nameRu), `${r.nameRu}: «не поняли код» засчитано за тревогу`).toBe(false);
    }
    expect(unknownColorRows(BULLETIN).length).toBe(3);
  });
});

describe('легенда цветов — в самой сводке, и белого в ней нет', () => {
  // Поправка 24.09: первая редакция утверждала, что цвета объяснены «где-то в
  // Пояснениях, которых в снимке нет». Легенда стоит внизу снимка. Проверка
  // держит оба факта, на которых стоит отказ угадывать белый: легенда есть,
  // и белого в ней нет. Появится определение белого в источнике — эта
  // проверка покраснеет и потребует пересмотреть его разбор.
  const text = HTML.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

  it('четыре цвета определены самим источником', () => {
    for (const c of ['Зеленый - вулкан в спокойном', 'Желтый - слабые', 'Оранжевый - большое', 'Красный - сильные']) {
      expect(text, `в легенде нет «${c}»`).toContain(c);
    }
  });

  it('белый в легенде не определён', () => {
    expect(text).not.toMatch(/Белый\s*[-–—]/);
  });
});

describe('отказ не выдаётся за пустую сводку', () => {
  it('страница без таблицы — жалоба, а не ноль вулканов', () => {
    const b = parseVmon('<html><body><p>Сервис временно недоступен</p></body></html>');
    expect(b.rows).toEqual([]);
    expect(b.problems.length, 'пустой разбор прошёл молча').toBeGreaterThan(0);
    expect(b.problems.join(' ')).toMatch(/не разобрана/);
  });

  it('таблица без даты — жалоба, а строки всё равно разобраны', () => {
    const b = parseVmon(HTML.replace(/20\s+СЕНТЯБРЯ\s+2026/i, 'НЕДАВНО'));
    expect(b.observedDate).toBeNull();
    expect(b.problems.length).toBeGreaterThan(0);
    expect(b.rows.length, 'потеря даты не должна съедать наблюдения').toBe(15);
  });

  it('год берётся из строки, а не из часов сервера', () => {
    expect(parseVmonDate('ЗА ПРОШЕДШИЕ СУТКИ 3 МАРТА 2019 г.').iso).toBe('2019-03-03');
    expect(parseVmonDate('ЗА ПРОШЕДШИЕ СУТКИ 1 МАЯ 2020 г.').iso).toBe('2020-05-01');
  });

  it('месяц через «ё» не теряется', () => {
    expect(parseVmonDate('7 ФЕВРАЛЯ 2026 г.').iso).toBe('2026-02-07');
  });
});

describe('модуль ничего не пишет и никуда не ходит', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/services/safety/emsd-vmon.ts'), 'utf-8');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('ни сети, ни БД — как у соседнего kvert-vona', () => {
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/db-pool|pool\.query/);
    expect(code).not.toMatch(/INSERT INTO|UPDATE /);
  });

  it('своего словаря вулканов и своего разбора цвета не заводит', () => {
    // Второй словарь разошёлся бы с первым на первом же новом вулкане (§12).
    expect(code).toContain('normalizeVolcanoName');
    expect(code).toContain('parseColor');
    expect(code, 'заведён свой разбор цвета').not.toMatch(/зел[её]н.*=>|'green'\s*:/);
  });

  it('адрес сводки — одна константа', () => {
    expect(EMSD_VMON_URL).toBe('https://www.emsd.ru/vmon/');
    expect((code.match(/emsd\.ru\/vmon/g) ?? []).length).toBe(1);
  });
});
