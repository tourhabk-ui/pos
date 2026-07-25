/**
 * Петля обратной связи эволюции, собранная после инцидента 24.07 (десять
 * ложных critical про один booking-роут).
 *
 * Три инварианта:
 *  1. Сигнатура претензии — по КЛАССУ, а не формулировке: один отказ глушит
 *     все перефразировки (именно они завалили трекер).
 *  2. Детерминированные объективы находят факт по синтаксису и молчат, когда
 *     защита есть, — то, на чём врала модель.
 *  3. Точность — цена ошибки: просела → догадки не публикуются, а
 *     детерминированные находки идут дальше.
 */
import { describe, it, expect } from 'vitest';
import { claimClass, claimSignature, dropRejected } from '@/lib/agents/evo/claim-signature';
import { checkRouteAuthGate, checkLegacyUsage, checkConsoleLog } from '@/lib/agents/evo/static-checks';
import { computePrecision, decidePublish, applyPublishDecision, isModelGuess, MIN_SAMPLE } from '@/lib/agents/evo/precision';

describe('claim-signature: класс претензии, а не формулировка', () => {
  it('семь перефразировок «нет auth» дают ОДИН класс', () => {
    const variants = [
      'Отсутствует requireAuth/requireAdmin',
      'Отсутствует requireAuth на маршруте',
      'Route не защищён middleware авторизации',
      'Отсутствует проверка авторизации',
      'Роут создания бронирования не проверяет JWT-токен',
      'Обработчик POST не вызывает requireAuth()',
      'Любой неавторизованный пользователь может создать бронь',
    ];
    const classes = new Set(variants.map((t) => claimClass(t)));
    expect(classes).toEqual(new Set(['missing_auth']));
  });

  it('разные классы не сливаются', () => {
    expect(claimClass('Вызов не обёрнут в try/catch')).toBe('missing_try_catch');
    expect(claimClass('Race condition: нет FOR UPDATE при бронировании')).toBe('missing_lock');
    expect(claimClass('SQL-инъекция через конкатенацию строк')).toBe('sql_injection');
  });

  it('сигнатура = файл + класс: перефразировки схлопываются в один ключ', () => {
    const a = claimSignature({ file_path: 'app/api/x/route.ts', title: 'Отсутствует requireAuth' });
    const b = claimSignature({ file_path: 'app/api/x/route.ts', title: 'Нет проверки авторизации на роуте' });
    expect(a).toBe(b);
  });

  it('один файл — разные классы: ключи разные', () => {
    const auth = claimSignature({ file_path: 'a.ts', title: 'Нет requireAuth' });
    const tc = claimSignature({ file_path: 'a.ts', title: 'Нет try/catch' });
    expect(auth).not.toBe(tc);
  });

  it('dropRejected глушит ВСЕ перефразировки отвергнутого класса', () => {
    const rejected = new Set([claimSignature({ file_path: 'r.ts', title: 'Отсутствует requireAuth' })]);
    const incoming = [
      { file_path: 'r.ts', title: 'Route не защищён middleware авторизации' },
      { file_path: 'r.ts', title: 'Нет проверки прав доступа' },
      { file_path: 'r.ts', title: 'Нет try/catch' },          // другой класс — проходит
      { file_path: 'other.ts', title: 'Отсутствует requireAuth' }, // другой файл — проходит
    ];
    const kept = dropRejected(incoming, rejected);
    expect(kept.map((f) => f.title)).toEqual(['Нет try/catch', 'Отсутствует requireAuth']);
  });
});

describe('static-checks: факт по синтаксису вместо догадки', () => {
  const authedRoute = `
    import { verifyToken, extractToken } from '@/lib/auth/jwt';
    export async function POST(req: Request) {
      const token = extractToken(req.headers.get('Authorization'));
      const user = await verifyToken(token);
      return Response.json({ ok: true });
    }`;

  it('роут С защитой — молчит (то, на чём врала модель)', () => {
    expect(checkRouteAuthGate('app/api/hub/bookings/create/route.ts', authedRoute)).toEqual([]);
  });

  it('мутирующий роут БЕЗ защиты — находка critical', () => {
    const naked = `export async function POST(req: Request) { return Response.json({}); }`;
    const found = checkRouteAuthGate('app/api/hub/secret/route.ts', naked);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('critical');
    expect(found[0].title).toContain('POST');
  });

  it('GET без защиты — не находка (читающий роут)', () => {
    const get = `export async function GET() { return Response.json({}); }`;
    expect(checkRouteAuthGate('app/api/hub/list/route.ts', get)).toEqual([]);
  });

  it('публичный по замыслу роут (вебхук/платежи) — не находка', () => {
    const naked = `export async function POST() { return Response.json({}); }`;
    expect(checkRouteAuthGate('app/api/payments/callback/route.ts', naked)).toEqual([]);
    expect(checkRouteAuthGate('app/api/webhook/route.ts', naked)).toEqual([]);
  });

  it('устаревшие таблицы и дефолтный импорт pool — находки', () => {
    const bad = `import pool from '@/lib/db-pool';\nconst r = await query('SELECT * FROM bookings');`;
    const found = checkLegacyUsage('lib/x.ts', bad);
    const titles = found.map((f) => f.title).join(' | ');
    expect(titles).toContain('Дефолтный импорт pool');
    expect(titles).toContain('устаревшей таблице bookings');
  });

  it('корректный код конвенций — молчит', () => {
    const good = `import { pool } from '@/lib/db-pool';\nconst r = await query('SELECT * FROM operator_bookings');`;
    expect(checkLegacyUsage('lib/x.ts', good)).toEqual([]);
  });

  it('console.log ловится, console.error — нет', () => {
    expect(checkConsoleLog('lib/a.ts', 'console.log("hi")')).toHaveLength(1);
    expect(checkConsoleLog('lib/a.ts', 'console.error("boom")')).toEqual([]);
  });

  it('тесты не проверяются (console.log там законен)', () => {
    expect(checkConsoleLog('lib/a.test.ts', 'console.log("hi")')).toEqual([]);
  });
});

describe('precision: цена ошибки', () => {
  it('малая выборка — не судим (период привыкания)', () => {
    expect(computePrecision({ accepted: 1, rejected: 2 })).toBeNull();
    expect(decidePublish({ accepted: 1, rejected: 2 }).allowGuesses).toBe(true);
  });

  it('ночь 24.07 (0 принято, 10 отвергнуто) — догадки останавливаются', () => {
    const d = decidePublish({ accepted: 0, rejected: 10 });
    expect(d.precision).toBe(0);
    expect(d.allowGuesses).toBe(false);
    expect(d.reason).toContain('ниже порога');
  });

  it('здоровая точность — публикация в норме', () => {
    const d = decidePublish({ accepted: 8, rejected: 2 });
    expect(d.allowGuesses).toBe(true);
    expect(d.precision).toBeCloseTo(0.8);
  });

  it('при запрете догадок детерминированные находки и разведка ИДУТ', () => {
    const d = decidePublish({ accepted: 0, rejected: MIN_SAMPLE + 2 });
    const findings = [
      { category: 'bug' },       // догадка модели
      { category: 'security' },  // static-checks
      { category: 'ux' },        // мок-детектор
      { category: 'intel' },     // разведка
    ];
    const out = applyPublishDecision(findings, d).map((f) => f.category);
    expect(out).toEqual(['security', 'ux', 'intel']);
  });

  it('isModelGuess: только догадки помечены', () => {
    expect(isModelGuess('bug')).toBe(true);
    expect(isModelGuess('security')).toBe(false);
    expect(isModelGuess('intel')).toBe(false);
  });
});

/**
 * Регрессия по итогам аудита админки 24.07: auth-объектив клеймил защищённые
 * роуты, потому что знал только именованные хелперы. Реальные формы защиты в
 * репо шире — гвард обязан их знать, иначе сам становится источником лжи.
 */
describe('checkRouteAuthGate — формы защиты без именованного хелпера', () => {
  it('сверка секрета через timingSafeEqual (issue-token) — не находка', () => {
    const src = `import { timingSafeEqual } from 'crypto';
export async function POST(req: NextRequest) {
  const a = Buffer.from(process.env.ADMIN_TOKEN_SECRET!);
  const b = Buffer.from(parsed.data.secret);
  if (!(a.length === b.length && timingSafeEqual(a, b))) return NextResponse.json({}, { status: 401 });
  return NextResponse.json({ ok: true });
}`;
    expect(checkRouteAuthGate('app/api/admin/auth/issue-token/route.ts', src)).toEqual([]);
  });

  it('инлайн-сверка Authorization с CRON_SECRET (max-send) — не находка', () => {
    const src = `export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== \`Bearer \${process.env.CRON_SECRET}\`) return NextResponse.json({}, { status: 401 });
  return NextResponse.json({ ok: true });
}`;
    expect(checkRouteAuthGate('app/api/admin/max-send/route.ts', src)).toEqual([]);
  });

  it('роут действительно без защиты — по-прежнему находка', () => {
    const src = `export async function DELETE() { return NextResponse.json({}); }`;
    expect(checkRouteAuthGate('app/api/admin/wipe/route.ts', src)).toHaveLength(1);
  });
});
