/**
 * Вердикт «Идти / Осторожно / Не сегодня» — схема, а не оракул.
 *
 * Три проверки, названные владельцем как условие того, что это редукционная
 * схема в духе Мунтера, а не красивая уверенность:
 *
 *   1. Одинаковые входы → один и тот же статус.
 *   2. Выкинули сигнал → либо тот же статус с другой причиной, либо честное
 *      «данных мало».
 *   3. Нет почти ничего → НЕ «Идти».
 *
 * И четвёртая, добавленная после его же замечания «не пережестить, а то все
 * маршруты станут красными»: в обычный тихий день вердикт обязан быть
 * зелёным. Вердикт, который всегда одного цвета, перестают читать — это тот
 * же дефект, что зелёная плашка из нуля данных, только с обратным знаком.
 */
import { describe, it, expect } from 'vitest';
import { goVerdict, VERDICT_LABELS, type RouteSignals } from '@/lib/routes/go-verdict';

/** Обычный тихий день: источники ответили, ничего не случилось. */
const CLEAR: RouteSignals = {
  alerts: [],
  volcanoes: [{ name: 'Авачинский', acc: 'green' }],
  inSeason: true,
  weather: { severe: false, note: 'ясно' },
};

/** Ничего не известно — экран, открытый без связи и без данных. */
const BLANK: RouteSignals = {
  alerts: null, volcanoes: null, inSeason: null, weather: null,
};

describe('проверка 1: схема воспроизводима', () => {
  it('одинаковые входы дают одинаковый ответ', () => {
    expect(goVerdict(CLEAR)).toEqual(goVerdict({ ...CLEAR }));
    expect(goVerdict(BLANK)).toEqual(goVerdict({ ...BLANK }));
  });

  it('обращения ко времени внутри нет — иначе ответ плыл бы сам по себе', () => {
    const a = goVerdict(CLEAR);
    const b = goVerdict(CLEAR);
    expect(a.status).toBe(b.status);
    expect(a.code).toBe(b.code);
  });
});

describe('проверка 2: убрали сигнал — ответ честнее, а не тише', () => {
  it('нет данных о предупреждениях — «Осторожно» с названной нехваткой', () => {
    const v = goVerdict({ ...CLEAR, alerts: null });
    expect(v.status).toBe('caution');
    expect(v.code).toBe('signals_unknown');
    expect(v.unknown).toContain('предупреждения');
  });

  it('нет данных о вулканах — то же самое', () => {
    expect(goVerdict({ ...CLEAR, volcanoes: null }).unknown).toContain('вулканы на маршруте');
  });

  it('пустой список и «не знаем» — разные вещи', () => {
    expect(goVerdict({ ...CLEAR, alerts: [] }).status).toBe('go');
    expect(goVerdict({ ...CLEAR, alerts: null }).status).toBe('caution');
  });
});

describe('проверка 3: незнание никогда не даёт зелёного', () => {
  it('пустой вход — не «Идти»', () => {
    expect(goVerdict(BLANK).status).not.toBe('go');
  });

  it('и причина названа', () => {
    expect(goVerdict(BLANK).code).toBe('signals_unknown');
    expect(goVerdict(BLANK).unknown.length).toBeGreaterThan(0);
  });
});

describe('проверка 4: в обычный день вердикт зелёный', () => {
  it('тихий день — «Идти»', () => {
    expect(goVerdict(CLEAR).status).toBe('go');
  });

  it('жёлтый код рядом — это фон Камчатки, а не событие', () => {
    // Шивелуч и Ключевской стоят жёлтыми большую часть года. Красить из-за
    // этого каждый маршрут в округе значит приучить не смотреть на цвет.
    expect(goVerdict({ ...CLEAR, volcanoes: [{ name: 'Шивелуч', acc: 'yellow' }] }).status).toBe('go');
  });

  it('нет прогноза погоды — не повод желтить', () => {
    // Опасная погода доезжает предупреждением МЧС: циклон 10.08 пришёл именно
    // так. Молчание внешнего прогноза не должно красить полуостров.
    expect(goVerdict({ ...CLEAR, weather: null }).status).toBe('go');
  });

  it('сезон не задан в данных — тоже не повод', () => {
    expect(goVerdict({ ...CLEAR, inSeason: null }).status).toBe('go');
  });

  it('готовность человека в вердикт не входит вовсе', () => {
    // Не скачан пакет и не оформлена регистрация — это чек-лист сборов.
    // Их нет во входе схемы, и добавлять их сюда нельзя: они не про сегодня.
    const keys = Object.keys(CLEAR);
    expect(keys).not.toContain('offlineReady');
    expect(keys).not.toContain('mchsDone');
    expect(keys).not.toContain('trackFidelity');
  });

  it('на десяти обычных днях подряд зелёного большинство', () => {
    // Прямая проверка опасения «все маршруты станут красными». Набор — то,
    // что бывает на Камчатке в обычную неделю.
    const typical: RouteSignals[] = [
      CLEAR,
      { ...CLEAR, volcanoes: [{ name: 'Ключевской', acc: 'yellow' }] },
      { ...CLEAR, volcanoes: [{ name: 'Безымянный', acc: 'green' }, { name: 'Шивелуч', acc: 'yellow' }] },
      { ...CLEAR, weather: null },
      { ...CLEAR, inSeason: null },
      { ...CLEAR, alerts: [] },
      { ...CLEAR, weather: { severe: false, note: 'облачно' } },
      { ...CLEAR, volcanoes: [] },
      { ...CLEAR, volcanoes: [{ name: 'Мутновский', acc: 'orange' }] }, // жёлтый флаг — законный
      { ...CLEAR, alerts: [{ title: 'Ограничение проезда', severity: 1 }] }, // и этот
    ];
    const green = typical.filter((s) => goVerdict(s).status === 'go').length;
    expect(green).toBeGreaterThanOrEqual(8);
  });
});

describe('запреты сильнее сомнений', () => {
  it('предупреждение важности 2 — «Не сегодня», и оно названо', () => {
    const v = goVerdict({
      ...CLEAR,
      alerts: [{ title: 'Тургруппам воздержаться от выхода на маршруты', severity: 2 }],
    });
    expect(v.status).toBe('no');
    expect(v.code).toBe('alert_ban');
    expect(v.reason).toContain('Тургруппам');
  });

  it('красный код KVERT — «Не сегодня» с именем вулкана', () => {
    const v = goVerdict({ ...CLEAR, volcanoes: [{ name: 'Шивелуч', acc: 'red' }] });
    expect(v.status).toBe('no');
    expect(v.code).toBe('volcano_red');
  });

  it('опасная погода — «Не сегодня»', () => {
    const v = goVerdict({ ...CLEAR, weather: { severe: true, note: 'очень сильный дождь' } });
    expect(v.status).toBe('no');
    expect(v.reason).toContain('дождь');
  });

  it('запрет побеждает даже при полном незнании остального', () => {
    // Иначе «данных мало» перекрыло бы прямой запрет МЧС.
    const v = goVerdict({ ...BLANK, alerts: [{ title: 'Сход лавин', severity: 3 }] });
    expect(v.status).toBe('no');
    expect(v.code).toBe('alert_ban');
  });
});

describe('осторожность называет свою причину', () => {
  const cases: Array<[string, Partial<RouteSignals>, string]> = [
    ['оранжевый вулкан', { volcanoes: [{ name: 'Мутновский', acc: 'orange' }] }, 'volcano_orange'],
    ['предупреждение важности 1', { alerts: [{ title: 'Ограничение проезда', severity: 1 }] }, 'alert_warning'],
    ['вне сезона', { inSeason: false }, 'out_of_season'],
  ];

  for (const [name, patch, code] of cases) {
    it(`${name} → «Осторожно», код ${code}`, () => {
      const v = goVerdict({ ...CLEAR, ...patch });
      expect(v.status).toBe('caution');
      expect(v.code).toBe(code);
    });
  }
});

describe('код причины стабилен и отделён от текста', () => {
  it('у каждого исхода есть короткий код', () => {
    for (const s of [CLEAR, BLANK, { ...CLEAR, inSeason: false }]) {
      expect(goVerdict(s).code).toMatch(/^[a-z_]+$/);
    }
  });

  it('причина — одна строка, а не панель', () => {
    for (const s of [CLEAR, BLANK, { ...CLEAR, volcanoes: [{ name: 'К', acc: 'red' as const }] }]) {
      expect(goVerdict(s).reason).not.toContain('\n');
      expect(goVerdict(s).reason.length).toBeLessThan(120);
    }
  });

  it('подписи статусов — человеческие слова', () => {
    expect(VERDICT_LABELS.go).toBe('Идти');
    expect(VERDICT_LABELS.caution).toBe('Осторожно');
    expect(VERDICT_LABELS.no).toBe('Не сегодня');
  });
});
