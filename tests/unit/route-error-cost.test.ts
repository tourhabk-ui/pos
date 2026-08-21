/**
 * Ф5: ядро собирается по цене ошибки, а не по шуму.
 *
 * План требовал приоритет «по фактическим открытиям карточек». Замер 19.08:
 * у самой популярной записи ШЕСТЬ открытий и ОДИН посетитель — сортировать по
 * такой разнице значит сортировать шум. Решение владельца 21.08: ядро — это
 * «где ошибиться дороже всего».
 *
 * Ключевая асимметрия, которую держит этот сторож: НА ТУРЕ С ОПЕРАТОРОМ у
 * человека есть проводник — живая страховка от нашей ошибки; на самостоятельном
 * выходе у него есть только мы. Поэтому отсутствие оператора ПОВЫШАЕТ
 * приоритет, а не понижает, и первый порыв «вести ядро по коммерции» здесь
 * прямо запрещён.
 */
import { describe, it, expect } from 'vitest';
import {
  byErrorCost, buildCore, errorCostSignals, hazardState, whyInCore,
  type ErrorCostInput,
} from '@/lib/routes/error-cost';

const route = (o: Partial<ErrorCostInput> & { id: string; title: string }): ErrorCostInput => ({
  mchsRequired: false, hazards: [], tours: 0, parkName: null, verdict: 'navigable', ...o,
});

describe('опасности: «не смотрели» не равно «безопасно»', () => {
  it('три состояния различимы', () => {
    expect(hazardState(['лавины'])).toBe('listed');
    expect(hazardState([])).toBe('none');
    expect(hazardState(null)).toBe('unknown');
  });

  it('непроверенные опасности повышают приоритет наравне с названными', () => {
    // Непроверенный опасный маршрут выглядит так же, как проверенный
    // безопасный — и это худшее из состояний, а не нейтральное.
    const unknown = route({ id: 'u', title: 'А', hazards: null });
    const none = route({ id: 'n', title: 'Б', hazards: [] });
    expect(byErrorCost(unknown, none)).toBeLessThan(0);
  });

  it('«не проверялись» видно человеку словами', () => {
    expect(whyInCore(route({ id: 'x', title: 'Х', hazards: null }))).toContain('не проверялись');
  });
});

describe('без оператора — выше, а не ниже', () => {
  it('самостоятельный опасный маршрут обгоняет такой же с туром', () => {
    // Это и есть решение Ф5: проводник — живая страховка, и там, где её нет,
    // наша ошибка стоит дороже.
    const solo = route({ id: 's', title: 'Соло', mchsRequired: true, tours: 0 });
    const guided = route({ id: 'g', title: 'Соло', mchsRequired: true, tours: 3 });
    expect(byErrorCost(solo, guided)).toBeLessThan(0);
  });

  it('коммерция сама по себе в ядро не поднимает', () => {
    const commercial = route({ id: 'c', title: 'Коммерческий', tours: 9, hazards: [] });
    const dangerous = route({ id: 'd', title: 'Опасный', tours: 0, mchsRequired: true });
    const core = buildCore([commercial, dangerous], 1);
    expect(core[0].id).toBe('d');
  });
});

describe('порядок признаков', () => {
  it('МЧС — сильнейший признак', () => {
    const mchs = route({ id: 'm', title: 'Я', mchsRequired: true, tours: 5, hazards: [] });
    const rest = route({ id: 'r', title: 'А', mchsRequired: false, tours: 0, hazards: ['камнепад'], parkName: 'Налычево' });
    expect(byErrorCost(mchs, rest)).toBeLessThan(0);
  });

  it('признаки не складываются в балл — сравниваются по очереди', () => {
    // Сумма выдумала бы курс обмена между «нужна МЧС» и «нет оператора».
    const many = route({ id: 'many', title: 'Б', mchsRequired: false, tours: 0, hazards: ['а'], parkName: 'П' });
    const one = route({ id: 'one', title: 'А', mchsRequired: true, tours: 5, hazards: [], parkName: null });
    expect(errorCostSignals(many)).toBeGreaterThan(errorCostSignals(one));
    expect(byErrorCost(one, many)).toBeLessThan(0); // но МЧС всё равно первее
  });

  it('счётчик признаков показывается, но не сортирует', () => {
    expect(errorCostSignals(route({ id: 'x', title: 'Х', mchsRequired: true, hazards: ['а'], tours: 0, parkName: 'П' }))).toBe(4);
    expect(errorCostSignals(route({ id: 'y', title: 'Y', tours: 5, hazards: [] }))).toBe(0);
  });
});

describe('ядро воспроизводимо и осмысленно', () => {
  it('равные записи упорядочены по заголовку — не лотерея', () => {
    // Без последнего ключа «ядро» менялось бы от прогона к прогону.
    const a = route({ id: '1', title: 'Ббб', mchsRequired: true });
    const b = route({ id: '2', title: 'Ааа', mchsRequired: true });
    expect(byErrorCost(a, b)).toBeGreaterThan(0);
    expect(buildCore([a, b]).map((r) => r.id)).toEqual(['2', '1']);
  });

  it('не пешие в ядро не попадают', () => {
    // Проверять описание тропы там, где тропы нет, — работа впустую.
    const notFoot = route({ id: 'nf', title: 'Вертолётный', mchsRequired: true, verdict: 'not_on_foot' });
    const foot = route({ id: 'f', title: 'Пеший', mchsRequired: true, verdict: 'orientation_only' });
    expect(buildCore([notFoot, foot]).map((r) => r.id)).toEqual(['f']);
  });

  it('непригодные сегодня остаются: ради них ядро и собирается', () => {
    const rough = route({ id: 'o', title: 'Черновой', mchsRequired: true, verdict: 'orientation_only' });
    expect(buildCore([rough])).toHaveLength(1);
  });

  it('размер ядра ограничен и не выдумывается', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      route({ id: String(i), title: `М${String(i).padStart(2, '0')}`, mchsRequired: true }));
    expect(buildCore(rows)).toHaveLength(20);
    expect(buildCore(rows, 5)).toHaveLength(5);
  });

  it('у каждой записи ядра сказано, почему она здесь', () => {
    const core = buildCore([route({ id: 'x', title: 'Х', mchsRequired: true, hazards: ['лавины'], tours: 0 })]);
    expect(core[0].why).toContain('обязательна регистрация МЧС');
    expect(core[0].why).toContain('идут без оператора');
    expect(core[0].unguided).toBe(true);
  });

  it('пустой вход даёт пустое ядро, а не выдуманное', () => {
    expect(buildCore([])).toEqual([]);
  });
});
