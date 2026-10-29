/**
 * Разбор METAR аэродрома (lib/flights/metar) — вызовом на сводках в форме,
 * в которой их выпускает АМСГ Елизово: ветер в м/с, видимость в метрах,
 * группы состояния полосы, тренд.
 *
 * Правило §4.0: незнакомая группа не пересказывается догадкой, но и не
 * пропадает молча; «нет ветра в сводке» не равно «штиль», «не измерен» не
 * равно ни тому ни другому; тренд (что будет) не смешивается с «сейчас»;
 * пустая сводка (NIL) не выдаётся за погоду.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMetar, metarTime, weatherWords, windWords, visibilityWords, metarLines, latestMetar, hasObservation,
} from '@/lib/flights/metar';

const NOW = new Date('2026-10-29T02:10:00Z');
const lines = (raw: string) => metarLines(parseMetar(raw, NOW)!);

describe('parseMetar', () => {
  it('обычная сводка: ветер, видимость, облачность, температура, давление; полоса и тренд не мешают', () => {
    const m = parseMetar('METAR UHPP 290130Z 32005MPS 9999 BKN020 M02/M05 Q1012 R16L/290050 NOSIG=', NOW)!;
    expect(m.station).toBe('UHPP');
    expect(m.observedAt).toBe('2026-10-29T01:30:00.000Z');
    expect(m).toMatchObject({ windDirDeg: 320, windMps: 5, gustMps: null, visibilityM: 10000, tempC: -2, dewC: -5, qnhHpa: 1012 });
    expect(m.clouds).toEqual([{ cover: 'BKN', baseM: 610, convective: null }]);
    expect(m.unparsed).toEqual([]);
    expect(metarLines(m)).toEqual([
      'ветер северо-западный 5 м/с', 'видимость 10 км и более', 'облачность: значительная от 610 м', '−2 °C',
    ]);
  });

  it('настоящая сводка Елизово 29.10 (NOAA AWC, raw): слои снизу вверх, CB у своего слоя', () => {
    const raw = 'METAR UHPP 290130Z 31012G17MPS 9999 FEW040CB SCT050 BKN072 04/M08 Q0990 R34L/CLRD62 NOSIG RMK MT OBSC QFE739/0985';
    const m = parseMetar(raw, NOW)!;
    expect(m.unparsed).toEqual([]);
    expect(metarLines(m)).toEqual([
      'ветер северо-западный 12 м/с, порывы 17',
      'видимость 10 км и более',
      'облачность: незначительная от 1220 м, кучево-дождевые; рассеянная от 1520 м; значительная от 2190 м',
      '4 °C',
    ]);
  });

  it('метель: порывы, явления, вертикальная видимость; тренд TEMPO в «сейчас» не попадает', () => {
    const m = parseMetar('UHPP 290100Z 01012G18MPS 0800 +SHSN BLSN VV004 M05/M06 Q0998 R16L/590235 TEMPO 0400 +SHSN', NOW)!;
    expect(m).toMatchObject({ windMps: 12, gustMps: 18, visibilityM: 800, verticalVisibilityM: 120, skyObscured: true });
    expect(m.weather).toEqual(['+SHSN', 'BLSN']);
    expect(metarLines(m)).toEqual([
      'ветер северный 12 м/с, порывы 18',
      'видимость 800 м',
      'сильный ливневый снег',
      'метель',
      'небо не видно, вертикальная видимость 120 м',
      '−5 °C',
    ]);
  });

  it('штиль и CAVOK — сказано словами, видимость не дублируется', () => {
    const m = parseMetar('UHPP 290030Z 00000MPS CAVOK 03/M01 Q1020 NOSIG', NOW)!;
    expect(m.windMps).toBe(0);
    expect(m.cavok).toBe(true);
    expect(metarLines(m)).toEqual(['штиль', 'видимость 10 км и более, облаков ниже 1500 м и явлений погоды нет', '3 °C']);
  });

  it('ветра нет в сводке — не «штиль», а ничего; не измерен — «ветер не измерен»', () => {
    const m = parseMetar('UHPP 290030Z 9999 FEW030 03/M01 Q1020', NOW)!;
    expect(m.windMps).toBeNull();
    expect(windWords(m)).toBeNull();
    expect(metarLines(m)[0]).toBe('видимость 10 км и более');
    const auto = parseMetar('UHPP 290030Z AUTO /////MPS 9999 FEW030 03/M01 Q1020', NOW)!;
    expect(auto.windMps).toBeNull();
    expect(metarLines(auto)[0]).toBe('ветер не измерен');
  });

  it('узлы переводятся в м/с; незнакомая группа не пересказывается, но названа', () => {
    const m = parseMetar('PAED 290153Z 34010G20KT 10SM FEW050 M02/M08 A2992 XYZ12', NOW)!;
    expect(m).toMatchObject({ windMps: 5, gustMps: 10, visibilityM: null });
    expect(m.unparsed).toEqual(['10SM', 'XYZ12']);
    const out = metarLines(m);
    expect(out).toContain('часть сводки не разобрана: 10SM XYZ12');
    expect(out.filter((l) => l.startsWith('видимость'))).toEqual([]);
  });

  it('не сводка — null', () => {
    expect(parseMetar('', NOW)).toBeNull();
    expect(parseMetar('<html>error</html>', NOW)).toBeNull();
  });
});

describe('облачность словами по количеству', () => {
  it('FEW и SCT не называются «разорванной» — у каждого слоя своё слово', () => {
    expect(lines('UHPP 290130Z 31012MPS 9999 FEW040 SCT050 04/M08 Q0990 NOSIG'))
      .toContain('облачность: незначительная от 1220 м; рассеянная от 1520 м');
  });
  it('сплошная без высоты — «высота не указана», а не пропущена', () => {
    expect(lines('UHPP 290130Z AUTO 31012MPS 9999 OVC/// 04/M08 Q0990'))
      .toContain('облачность: сплошная, высота не указана');
  });
  it('TCU и CB — каждый со своей высотой, CB не опускается до высоты TCU', () => {
    expect(lines('UHPP 290130Z 31012MPS 9999 FEW015TCU BKN040CB 04/M08 Q0990 NOSIG'))
      .toContain('облачность: незначительная от 460 м, мощные кучевые; значительная от 1220 м, кучево-дождевые');
  });
  it('VV/// — небо не видно, высота не указана; не молчание', () => {
    const m = parseMetar('UHPP 290130Z 01003MPS 0100 FG VV/// M01/M01 Q1000 NOSIG', NOW)!;
    expect(m.skyObscured).toBe(true);
    expect(metarLines(m)).toContain('небо не видно, вертикальная видимость не указана');
  });
});

describe('опасное у полосы', () => {
  it('сдвиг ветра и закрытие снегом названы, а не пропущены', () => {
    const out = lines('UHPP 290130Z 31012G20MPS 0400 +SN BLSN VV002 M04/M05 Q0990 WS R34L R/SNOCLO NOSIG');
    expect(out[0]).toBe('аэродром закрыт из-за снега');
    expect(out).toContain('сдвиг ветра на полосе 34L');
    expect(out.some((l) => l.startsWith('часть сводки не разобрана'))).toBe(false);
    expect(lines('UHPP 290130Z 31012MPS 9999 BKN020 04/M08 Q0990 WS ALL RWY')).toContain('сдвиг ветра на всех полосах');
  });
  it('пепел: VA — над аэродромом, VCVA — в окрестностях, не «над аэродромом поблизости»', () => {
    expect(weatherWords('VA')).toBe('вулканический пепел над аэродромом');
    expect(weatherWords('VCVA')).toBe('вулканический пепел в окрестностях аэродрома (8–16 км)');
    expect(lines('UHPP 290130Z 31005MPS 9999 VCVA SCT040 04/M08 Q0990').join(' ')).not.toMatch(/над аэродромом/);
  });
  it('знак у грозы с осадками — про осадки: «-TSRA» — гроза и слабый дождь', () => {
    expect(weatherWords('-TSRA')).toBe('гроза, слабый дождь');
    expect(weatherWords('+TSSN')).toBe('гроза, сильный снег');
    expect(weatherWords('TSRA')).toBe('гроза, дождь');
    expect(weatherWords('TS')).toBe('гроза');
    expect(weatherWords('VCTS')).toBe('гроза в окрестностях аэродрома (8–16 км)');
  });
  it('незамеренные группы «///» — отдельной строкой', () => {
    expect(lines('UHPP 290130Z AUTO 31005MPS //// // ////// 04/M08 Q0990')).toContain('часть значений в сводке не измерена («///»)');
  });
});

describe('пустая сводка (NIL) не выдаётся за погоду', () => {
  it('NIL и сводка без единой разобранной группы — не наблюдение', () => {
    expect(hasObservation(parseMetar('METAR UHPP 290200Z NIL', NOW)!)).toBe(false);
    expect(hasObservation(parseMetar('METAR UHPP 290200Z AUTO /////MPS //// // ////// ///// Q////', NOW)!)).toBe(false);
  });
  it('NIL после настоящей сводки — берётся настоящая', () => {
    const text = 'METAR UHPP 290130Z 31012MPS 9999 BKN020 04/M08 Q0990 NOSIG\nMETAR UHPP 290200Z NIL\n';
    const { metar, empty } = latestMetar(text, 'UHPP', NOW);
    expect(metar?.observedAt).toBe('2026-10-29T01:30:00.000Z');
    expect(empty).toBe(1);
  });
  it('все пустые — сводки нет, и это посчитано', () => {
    expect(latestMetar('METAR UHPP 290200Z NIL\nMETAR UHPP 290130Z NIL', 'UHPP', NOW)).toEqual({ metar: null, empty: 2 });
  });
});

describe('время сводки', () => {
  it('день 31 при «сейчас» 1 ноября — это 31 октября', () => {
    expect(metarTime('312330Z', new Date('2026-11-01T00:10:00Z'))).toBe('2026-10-31T23:30:00.000Z');
  });
  it('нет такого времени — null', () => {
    expect(metarTime('322400Z', NOW)).toBeNull();
  });
});

describe('словами', () => {
  it('род интенсивности по явлению, незнакомое — кодом', () => {
    expect(weatherWords('-DZ')).toBe('слабая морось');
    expect(weatherWords('-SN')).toBe('слабый снег');
    expect(weatherWords('VCSH')).toBe('ливень в окрестностях аэродрома (8–16 км)');
    expect(weatherWords('FZFG')).toBe('переохлаждённый туман');
    expect(weatherWords('UP')).toBe('явление UP');
  });
  it('видимость', () => {
    expect(visibilityWords(6000)).toBe('видимость 6 км');
    expect(visibilityWords(350)).toBe('видимость 350 м');
  });
});
