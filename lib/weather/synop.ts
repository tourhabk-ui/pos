/**
 * Осадки метеостанции из сводок SYNOP (FM-12) — факт для замера моделей (#2249).
 *
 * NOAA по Петропавловску-Камчатскому (WMO 32583) свежих осадков не даёт:
 * в GHCN-Daily за 120 дней ни одного дня PRCP, GSOD — пустой ответ
 * (weather-model-skill, прогоны 1–2, 08.10). Сами сводки станции есть на
 * Ogimet (проба 721): по строке на срок, осадки — группой 6RRRtR.
 *
 * Как их передаёт 32583 (проба 721, 01–07.10): дважды в сутки, в 09 и 21
 * UTC, сумма за 12 часов (tR=2), индикатор iR=1. В прочие сроки iR=4 — «не
 * измерялось», и это не ноль. Сутки собираются из двух двенадцатичасовых
 * сумм, а не угадыванием границы: окно станции известно точно.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ (§4.0): нет сводки (NIL), нет группы, «///», период не
 * назван, противоречивые дубли — «не знаю», а не «сухо». Сутки без любой из
 * двух половин в счёт не идут.
 */

export interface PrecipPeriod {
  /** Конец периода — срок сводки, ISO UTC до минут: `2026-10-02T21:00`. */
  endUtc: string;
  /** Длина периода в часах (code table 4019). */
  hours: number;
  /** Миллиметры; «следы» (990) — 0. */
  mm: number;
  /** Секция сводки, откуда группа: 1 — основная, 3 — региональная. */
  section: 1 | 3;
}

export interface SynopParse {
  periods: PrecipPeriod[];
  /** Сводок всего, из них NIL (срок не передан). */
  reports: number;
  nil: number;
  /** Сводок с iR=3: «осадков не было» без периода — в счёт не берём, считаем. */
  zeroWithoutPeriod: number;
  /** Строк, которые не удалось разобрать как сводку станции. */
  unparsed: number;
}

/** WMO code table 4019: tR → часы. 0 и «/» — период не назван. */
const TR_HOURS: Record<string, number> = { '1': 6, '2': 12, '3': 18, '4': 24, '5': 1, '6': 2, '7': 3, '8': 9, '9': 15 };

/** WMO code table 3590: RRR → мм. null — нет значения. */
export function decodeRRR(rrr: string): number | null {
  if (!/^\d{3}$/.test(rrr)) return null;
  const n = Number(rrr);
  if (n <= 989) return n;
  if (n === 990) return 0;
  return (n - 990) / 10;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Разбор ответа Ogimet `getsynop`: строка `ИНДЕКС,ГГГГ,ММ,ДД,ЧЧ,мм,AAXX …`.
 * Группа 6RRRtR берётся из секции 1 (если iR ∈ {0,1}) и из секции 3 (если
 * iR ∈ {0,2}); 7RRRR секции 3 — суточная сумма в десятых мм.
 */
export function parseSynopPrecip(text: string, station: string): SynopParse {
  const res: SynopParse = { periods: [], reports: 0, nil: 0, zeroWithoutPeriod: 0, unparsed: 0 };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 7 || parts[0] !== station) { res.unparsed++; continue; }
    const [, y, mo, d, h, mi] = parts.map((p) => p.trim());
    const report = parts.slice(6).join(',');
    if (![y, mo, d, h, mi].every((p) => /^\d+$/.test(p))) { res.unparsed++; continue; }
    const endUtc = `${y}-${pad(Number(mo))}-${pad(Number(d))}T${pad(Number(h))}:${pad(Number(mi))}`;
    const tokens = report.replace(/=+/g, ' ').trim().split(/\s+/);
    res.reports++;
    if (tokens.includes('NIL')) { res.nil++; continue; }
    // AAXX YYGGi IIiii iRixhVV Nddff [00fff] 1… 2… … | 333 … | 555 …
    if (tokens[0] !== 'AAXX' || tokens[2] !== station || !tokens[3] || !tokens[4]) { res.unparsed++; continue; }
    const iR = tokens[3][0];
    let i = 5;
    if (tokens[4].slice(3) === '99' && tokens[5]?.startsWith('00')) i = 6;
    const s3 = tokens.indexOf('333');
    const s5 = tokens.indexOf('555');
    const sec1End = [s3, s5].filter((x) => x >= 0).reduce((a, b) => Math.min(a, b), tokens.length);
    const sec1 = tokens.slice(i, sec1End);
    const sec3 = s3 >= 0 ? tokens.slice(s3 + 1, s5 > s3 ? s5 : tokens.length) : [];

    if (iR === '3') { res.zeroWithoutPeriod++; continue; }
    const push = (group: string, section: 1 | 3) => {
      const mm = decodeRRR(group.slice(1, 4));
      const hours = TR_HOURS[group[4]];
      if (mm !== null && hours !== undefined) res.periods.push({ endUtc, hours, mm, section });
    };
    if (iR === '0' || iR === '1') {
      const g = sec1.find((t) => /^6[0-9/]{4}$/.test(t));
      if (g) push(g, 1);
    }
    if (iR === '0' || iR === '2') {
      const g = sec3.find((t) => /^6[0-9/]{4}$/.test(t));
      if (g) push(g, 3);
    }
    // 7R24R24R24R24 — сумма за 24 часа, десятые доли мм; 9999 — следы.
    const g7 = sec3.find((t) => /^7\d{4}$/.test(t));
    if (g7) {
      const v = Number(g7.slice(1));
      res.periods.push({ endUtc, hours: 24, mm: v === 9999 ? 0 : v / 10, section: 3 });
    }
  }
  return res;
}

/**
 * Суточные суммы станции: сутки D — окно (D−1 E:00, D E:00] UTC, где E —
 * час конца суток станции. Берётся суточная сумма за этот срок, иначе две
 * двенадцатичасовые (концы в E−12 и E). Дубли одного периода с разными
 * значениями — «не знаю»: период выпадает, и сутки вместе с ним.
 *
 * Сопоставление с часовым рядом модели: значение Open-Meteo в метке t — сумма
 * за час, ЗАКАНЧИВАЮЩИЙСЯ в t. Окно (D−1 E, D E] — метки D−1 E+1 … D E, и
 * `dailySums` соберёт ровно их при сдвиге `23 − E` (для E=21 — +2 ч).
 */
export function synopDailyTotals(periods: readonly PrecipPeriod[], endHourUtc: number): Map<string, number> {
  const byKey = new Map<string, number | 'conflict'>();
  for (const p of periods) {
    const key = `${p.endUtc}|${p.hours}`;
    const prev = byKey.get(key);
    if (prev === undefined) byKey.set(key, p.mm);
    else if (prev !== 'conflict' && Math.abs(prev - p.mm) > 1e-9) byKey.set(key, 'conflict');
  }
  const value = (endUtc: string, hours: number): number | null => {
    const v = byKey.get(`${endUtc}|${hours}`);
    return typeof v === 'number' ? v : null;
  };
  const days = new Set([...byKey.keys()].map((k) => k.slice(0, 10)));
  const out = new Map<string, number>();
  const E = pad(endHourUtc);
  for (const day of [...days].sort()) {
    const end = `${day}T${E}:00`;
    const whole = value(end, 24);
    if (whole !== null) { out.set(day, Math.round(whole * 10) / 10); continue; }
    const firstEnd = new Date(Date.parse(`${end}Z`) - 12 * 3_600_000).toISOString().slice(0, 16);
    const a = value(firstEnd, 12);
    const b = value(end, 12);
    if (a !== null && b !== null) out.set(day, Math.round((a + b) * 10) / 10);
  }
  return out;
}

/** Сдвиг суток для `dailySums`, при котором окно модели совпадает с окном станции. */
export function modelOffsetForStationDay(endHourUtc: number): number {
  return 23 - endHourUtc;
}
