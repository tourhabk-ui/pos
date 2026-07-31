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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimClass, claimSignature, dropRejected, intelSignature } from '@/lib/agents/evo/claim-signature';
import { checkRouteAuthGate, checkLegacyUsage, checkConsoleLog } from '@/lib/agents/evo/static-checks';
import { computePrecision, decidePublish, applyPublishDecision, isModelGuess, issueVerdict, MIN_SAMPLE } from '@/lib/agents/evo/precision';

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

  // Путь обязан быть ПУБЛИЧНЫМ на Edge — иначе анонима отсекает middleware и
  // находки нет (см. блок «знание реальных рубежей репо» ниже). /api/discovery
  // объявлен публичным для GET и POST.
  it('мутирующий публичный роут БЕЗ защиты — находка critical', () => {
    const naked = `export async function POST(req: Request) { return Response.json({}); }`;
    const found = checkRouteAuthGate('app/api/discovery/route.ts', naked);
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

  it('при запрете догадок идут ТОЛЬКО детерминированные — intel гаснет вместе с bug', () => {
    // Контракт изменён 31.07: intel сочиняет callAIDecision по RSS, и «заземлена
    // в тексте дайджеста» не значит «заземлена в нашем коде». Пока intel была
    // вне тормоза, при просевшей точности она оставалась единственной
    // публикуемой категорией — трекер заполнялся только разведкой.
    const d = decidePublish({ accepted: 0, rejected: MIN_SAMPLE + 2 });
    const findings = [
      { category: 'bug' },       // догадка модели — гаснет
      { category: 'security' },  // static-checks — идёт
      { category: 'ux' },        // мок-детектор — идёт
      { category: 'intel' },     // разведка = тоже догадка модели — гаснет
    ];
    const out = applyPublishDecision(findings, d).map((f) => f.category);
    expect(out).toEqual(['security', 'ux']);
  });

  it('isModelGuess: intel — догадка модели, а не детерминированная находка', () => {
    expect(isModelGuess('bug')).toBe(true);
    expect(isModelGuess('security')).toBe(false);
    expect(isModelGuess('intel')).toBe(true);
  });
});

describe('issueVerdict: оба вердикта человека доезжают до находки', () => {
  // До 31.07 засчитывался только отказ. Принятие (обычный Close → completed)
  // не засчитывалось никак, поэтому точность accepted/(accepted+rejected)
  // систематически ползла вниз: отказы копились, принятия — нет. Ниже порога
  // гасли код-находки, и в трекере оставался только intel.
  it('completed — сделано, находка была полезной', () => {
    expect(issueVerdict('completed')).toBe('fixed');
  });

  it('not_planned и duplicate — отказ', () => {
    expect(issueVerdict('not_planned')).toBe('rejected');
    expect(issueVerdict('duplicate')).toBe('rejected');
  });

  it('закрытие без причины — НЕ вердикт: догадка двигала бы метрику глушения', () => {
    expect(issueVerdict(null)).toBeNull();
    expect(issueVerdict(undefined)).toBeNull();
    expect(issueVerdict('reopened')).toBeNull();
  });
});

describe('intelSignature: тема разведки, а не формулировка', () => {
  it('три заголовка про локальную модель — одна тема', () => {
    const variants = [
      { title: 'Офлайн-Кузьмич на 1-битной локальной модели', description: '', suggestion: '' },
      { title: 'Квантованная модель для работы в поле', description: 'llama.cpp без сети', suggestion: '' },
      { title: 'Локальная модель как офлайн-режим ассистента', description: '', suggestion: '' },
    ];
    const sigs = new Set(variants.map((v) => intelSignature(v)));
    expect(sigs.size).toBe(1);
    expect([...sigs][0]).toBe('intel::local_llm');
  });

  it('разные темы не сливаются', () => {
    expect(intelSignature({ title: 'Маршрутизация LLM-запросов по стоимости', description: '', suggestion: '' }))
      .not.toBe(intelSignature({ title: 'Мониторинг качества ответов Кузьмича', description: '', suggestion: '' }));
    expect(intelSignature({ title: 'Автоматическая разметка фото маршрутов', description: '', suggestion: '' }))
      .not.toBe(intelSignature({ title: 'Продвижение через AI-рекламу Google', description: '', suggestion: '' }));
  });

  it('неклассифицированная тема — хвост из заголовка: один отказ не глушит все прочие', () => {
    const a = intelSignature({ title: 'Партнёрство с сетью глэмпингов', description: '', suggestion: '' });
    const b = intelSignature({ title: 'Интеграция с ЖД-билетами', description: '', suggestion: '' });
    expect(a.startsWith('intel::other:')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('петля закрыта и в исходниках (не только в чистых функциях)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
  const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('evo-report разбирает вердикт через issueVerdict, а не только not_planned', () => {
    const src = code(read('app/api/cron/evo-report/route.ts'));
    expect(src, 'принятие человека снова перестало засчитываться').toMatch(/issueVerdict\(/);
    expect(src, 'жёсткая проверка not_planned вернулась мимо issueVerdict')
      .not.toMatch(/state_reason === 'not_planned'/);
  });

  it('intel-bridge дедупит по intelSignature, а не по точному title', () => {
    const src = code(read('lib/agents/evo/intel-bridge.ts'));
    expect(src, 'дедуп по строке заголовка пропускает перефразировки').not.toMatch(/title = \$1/);
    expect(src).toMatch(/intelSignature\(/);
  });

  it('репортёр получает счётчик висящих intel — бронь плавающая', () => {
    const src = code(read('app/api/cron/evo-report/route.ts'));
    expect(src, 'selectReportable снова зовётся без openIntelCount — бронь стала безусловной')
      .toMatch(/selectReportable\(\s*publishable\s*,\s*REPORT_LIMIT\s*,\s*openIntelCount\s*\)/);
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

/**
 * Регрессия по итогам аудита бизнес-процессов 25.07.
 *
 * Объектив auth знал только часть реальных хелперов репо и ничего не знал про
 * Edge-гвард. Результат: 66 «критичных дыр» на 623 роутах, из которых honest —
 * четыре. Оба перекоса ниже зафиксированы: не клеймить защищённое и не
 * оправдывать по-настоящему открытое.
 */
describe('checkRouteAuthGate — знание реальных рубежей репо', () => {
  it('verifyAuth (брони) — не находка', () => {
    const src = `import { verifyAuth } from '@/lib/auth';
export async function POST(req: NextRequest) {
  const auth = await verifyAuth(req);
  if (!auth.isAuthenticated) return NextResponse.json({}, { status: 401 });
  return NextResponse.json({ ok: true });
}`;
    expect(checkRouteAuthGate('app/api/bookings/[id]/cancel/route.ts', src)).toEqual([]);
  });

  it('authenticateUser/authorizeRole (платежи) — не находка', () => {
    const src = `import { authenticateUser, authorizeRole } from '@/lib/auth';
export async function POST(req: NextRequest) {
  const userId = await authenticateUser(req);
  if (!userId) return NextResponse.json({}, { status: 401 });
  return NextResponse.json({ ok: true });
}`;
    expect(checkRouteAuthGate('app/api/bookings/payments/route.ts', src)).toEqual([]);
  });

  it('requireOctoAuth (партнёрский Bearer-ключ) — не находка', () => {
    const src = `import { requireOctoAuth } from '@/lib/octo/auth';
export async function POST(req: NextRequest) {
  const a = await requireOctoAuth(req);
  if (a instanceof NextResponse) return a;
  return NextResponse.json({ ok: true });
}`;
    expect(checkRouteAuthGate('app/api/octo/bookings/route.ts', src)).toEqual([]);
  });

  it('путь закрыт Edge-гвардом (нет в реестре публичных) — не находка', () => {
    const naked = `export async function POST() { return NextResponse.json({}); }`;
    // /api/stay/* отсутствует в PUBLIC_API_ROUTES → аноним получает 401 на Edge
    expect(checkRouteAuthGate('app/api/stay/accommodations/route.ts', naked)).toEqual([]);
  });

  it('публичный на Edge и совсем без рубежа — находка', () => {
    const naked = `export async function POST() { return NextResponse.json({}); }`;
    // /api/planner/validate объявлен публичным — значит рубеж обязан быть в файле
    const found = checkRouteAuthGate('app/api/planner/validate/route.ts', naked);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('critical');
  });

  it('публичный на Edge, но с лимитером — не находка (аноним по замыслу)', () => {
    const src = `import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
const limiter = createRateLimiter({ windowMs: 60000, max: 20 });
export async function POST(req: NextRequest) {
  if (!limiter.check(getClientIp(req.headers))) return NextResponse.json({}, { status: 429 });
  return NextResponse.json({ ok: true });
}`;
    expect(checkRouteAuthGate('app/api/planner/validate/route.ts', src)).toEqual([]);
  });

  it('маршрут-заглушка (501) — не находка, мутировать нечего', () => {
    const src = `export async function POST() {
  return NextResponse.json({ status: 'not_implemented' }, { status: 501 });
}`;
    expect(checkRouteAuthGate('app/api/webhooks/payments/route.ts', src)).toEqual([]);
  });
});
