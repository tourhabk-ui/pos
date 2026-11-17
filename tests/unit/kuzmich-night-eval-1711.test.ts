/**
 * Ночной эвал Кузьмича 17.11 (прогон 43875975789), слово владельца «го»:
 * четыре ошибки ответов и одна 502, сделавшая прогон красным.
 *
 *   1. «Туров нет», когда туры есть: «Толбачик дешевле 70 000 — нет» при туре
 *      за 60 000; «Налычево — туров нет» при пяти. Дописка списка туров
 *      теперь поправляет ложное «нет» турами по словам самого вопроса и в
 *      бюджет, а «дешевле N» — тоже бюджет.
 *   2. «Бронь» вместо «заявки» — закрыто #3486 другой сессией, здесь не трогается.
 *   3. Выдуманная оценка безопасности: «вертолётный облёт — единственный
 *      безопасный способ увидеть Толбачик». Такое предложение вырезается на
 *      всех поверхностях; осторожный совет («самый безопасный вариант —
 *      отложить поход») остаётся.
 *   4. Вопрос о компании, а дописка «Ещё по запросу» прибавляла туры других
 *      компаний: при вопросе о продавце она туров не прибавляет и названные
 *      туры другим не приписывает. Резолвер — tests/unit/tour-choice.test.ts.
 *   5. 502 за 40 с — один повтор через 120 с, проверено настоящим bash.
 *
 * Эвал судит то же: ложное «нет» без поправки — провал, выдуманная оценка
 * безопасности — провал в каждом вопросе.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));

import { budgetOf, completeTourList } from '@/lib/kuzmich/tour-list-complete';
import { hasSafetyRanking, stripBannedAdvice, BANNED_ADVICE_NOTE } from '@/lib/kuzmich/banned-advice';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';
import { correctShownAnswer, finishKuzmichAnswer, SHOWN_SAFETY_RANKING_CORRECTION } from '@/lib/kuzmich/answer-guards';
import {
  deniesTours, judgeCommercial, referenceKey, TOURS_EXIST_CORRECTION_RE,
  type CommercialCheck, type ReferenceResult,
} from '@/lib/agents/eval/commercial-checks';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// Строки в формате get_tours.
const T41 = 'ID41: "Вулкан Плоский Толбачик" — Вулкан Плоский Толбачик  тип:trekking 4 дн. от 60 000 ₽/чел. | Оп: Край Вулканов | Расписания в системе нет';
const T73 = 'ID73: "Толбачик: по следам извержений, 4 дня" — Вулкан Плоский Толбачик  тип:volcano 4 дн. от 85 000 ₽/чел. | Оп: Андрей Запорожец | Мест: 4';
const T65 = 'ID65: "Вулкан Толбачик (джип-тур, 4 дня)" — Вулкан Толбачик  тип:jeep_safari 4 дн. от 115 000 ₽/чел. | Оп: Местечко Камчатка';
const T51 = 'ID51: "Вулкан Толбачик (вертолёт)" — Вулкан Толбачик  тип:helicopter  от 165 000 ₽/чел. | Оп: Местечко Камчатка';
const TOLBACHIK = [T41, T73, T65, T51].join('\n');
const N39 = 'ID39: "Налычевские термальные источники" — Налычево  тип:trekking 5 дн. от 70 000 ₽/чел. | Оп: Лагуна Экспедиция';
const N74 = 'ID74: "Природный парк Налычево, 3 дня" — Налычево  тип:trekking 3 дн. от 45 000 ₽/чел. | Оп: Андрей Запорожец';
const NALYCHEVO = [N39, N74].join('\n');

describe('1. ложное «туров нет» поправляется турами по словам вопроса', () => {
  it('«дешевле 70 000» — бюджет', () => {
    expect(budgetOf('Есть тур на Толбачик дешевле 70 000?')).toBe(70000);
    expect(budgetOf('не больше 50 000 на человека')).toBe(50000);
  });

  it('«дешевле 70 000 нет», а тур за 60 000 есть — поправка с ним, туры дороже — с оговоркой', () => {
    const answer = [
      'Туров на Толбачик дешевле 70 000 ₽ на платформе нет. Вот что есть:',
      '- «Толбачик: по следам извержений, 4 дня» — Андрей Запорожец — от 85 000 ₽/чел.',
      '- «Вулкан Толбачик (джип-тур, 4 дня)» — Местечко Камчатка — 115 000 ₽/чел.',
    ].join('\n');
    const out = completeTourList(answer, 'Есть тур на Толбачик дешевле 70 000?', [{ query: 'толбачик', output: TOLBACHIK }], TOLBACHIK);
    expect(out).toMatch(TOURS_EXIST_CORRECTION_RE);
    expect(out).toContain('Поправка: в бюджет 70 000 ₽ на платформе есть:\n- «Вулкан Плоский Толбачик» — Край Вулканов, от 60 000 ₽/чел.');
    // Тур за 165 000 в поправку не попадает: он не в бюджет.
    expect(out.slice(out.indexOf('Поправка'))).not.toContain('вертолёт');
    expect(out).not.toContain('Ещё по запросу');
  });

  it('«туров нет» без единого названного тура (Налычево) — поправка, а не молчание', () => {
    const answer = 'Сразу важное: природный парк «Налычево» сейчас в красном статусе. По турам: на витрине Ведара туров, которые захватывают именно Налычево, сейчас нет.';
    const out = completeTourList(answer, 'Какие туры захватывают Налычево?', [{ query: 'налычево', output: NALYCHEVO }], NALYCHEVO);
    expect(out.startsWith(answer)).toBe(true);
    expect(out).toContain('Поправка: по запросу на платформе туры есть:');
    expect(out).toContain('«Налычевские термальные источники» — Лагуна Экспедиция, от 70 000 ₽/чел.');
    expect(out).toContain('«Природный парк Налычево, 3 дня» — Андрей Запорожец, от 45 000 ₽/чел.');
  });

  it('поправка — только турами по словам вопроса, а не всем, что модель смотрела', () => {
    const answer = 'На витрине туров на Налычево сейчас нет.';
    const out = completeTourList(answer, 'Какие туры захватывают Налычево?', [{ query: 'толбачик', output: TOLBACHIK }, { query: 'налычево', output: NALYCHEVO }], `${TOLBACHIK}\n${NALYCHEVO}`);
    const fix = out.slice(out.indexOf('Поправка'));
    expect(fix).toContain('Налычевские');
    expect(fix).not.toContain('Толбачик');
  });

  it('«нет» не о существовании туров — не поправляется', () => {
    for (const answer of [
      'Туров на Налычево зимой нет: сезон летний.',
      'У туров на эту дату свободных мест нет.',
      'Расписания у этого тура нет — даты по заявке оператору.',
      'Отзывов о турах пока нет.',
    ]) {
      expect(deniesTours(answer), answer).toBe(false);
      expect(completeTourList(answer, 'Какие туры захватывают Налычево?', [{ query: 'налычево', output: NALYCHEVO }], NALYCHEVO), answer).toBe(answer);
    }
  });
});

describe('4. вопрос о продавце — дописка не подмешивает туры других компаний', () => {
  const answer = 'У «Местечка Камчатка» на Толбачик один тур:\n- «Вулкан Толбачик (вертолёт)» — 165 000 ₽ за человека.';
  const question = 'Какие туры на Толбачик у Местечка Камчатка?';

  it('без пометки о продавце дописка прибавила бы туры других компаний — так было ночью', () => {
    const out = completeTourList(answer, question, [{ query: 'толбачик', output: TOLBACHIK }], TOLBACHIK);
    expect(out).toContain('Ещё по запросу на платформе:');
    expect(out).toContain('Андрей Запорожец');
  });

  it('вопрос о продавце — ни «Ещё по запросу», ни «Кто проводит», ответ как есть', () => {
    const out = completeTourList(answer, question, [{ query: 'толбачик', output: TOLBACHIK }], TOLBACHIK, { seller: true });
    expect(out).toBe(answer);
  });

  it('«у него нет» о продавце — не ложное «туров нет»: у других компаний туры не подставляются', () => {
    const none = 'У «Местечка Камчатка» туров на Налычево нет.';
    expect(completeTourList(none, 'Есть у Местечка Камчатка туры на Налычево?', [{ query: 'налычево', output: NALYCHEVO }], NALYCHEVO, { seller: true })).toBe(none);
  });
});

const NIGHT_ANSWER = [
  'У «Местечка Камчатка» на Толбачик один тур: «Вулкан Толбачик (вертолёт)» — 165 000 ₽.',
  'Учти: природный парк «Ключевской» сейчас закрыт на зимний сезон, передвижение там крайне опасно. Так что по факту вертолётный облёт — это пока единственный безопасный способ увидеть Толбачик в это время года.',
  'Рассказать подробнее про программу тура?',
].join('\n\n');

describe('3. выдуманная оценка безопасности способа или тура', () => {
  it('ночная фраза вырезается целиком, остальное — и закрытый парк — остаётся; 112 о звере не дописывается', () => {
    const r = stripBannedAdvice(NIGHT_ANSWER);
    expect(r.ranking).toHaveLength(1);
    expect(r.text).not.toMatch(/безопасный способ/);
    expect(r.text).toContain('сейчас закрыт на зимний сезон');
    expect(r.text).toContain('Рассказать подробнее');
    expect(r.text).not.toContain(BANNED_ADVICE_NOTE);
  });

  it('осторожный совет и отрицание — не оценка тура, остаются', () => {
    for (const keep of [
      'Самый безопасный вариант сейчас — отложить поход до лета.',
      'Самый безопасный вариант — остаться в укрытии и звонить 112.',
      'Самый безопасный вариант сейчас: никуда не выходить до утра.',
      'Это не самый безопасный способ: без гида туда не ходят.',
      'Маршрут безопасен только с гидом.',
    ]) {
      expect(hasSafetyRanking(keep), keep).toBe(false);
      expect(stripBannedAdvice(keep).text, keep).toBe(keep);
    }
    for (const cut of [
      'Самый безопасный тур на Толбачик — джип-тур.',
      'Вертолёт — наиболее безопасный способ попасть к Узону.',
      // Осторожное слово дальше в предложении оценку не спасает (ревью PR #3495).
      'Вертолётный облёт — единственный безопасный способ увидеть Толбачик, пешком туда не поднимаются.',
      'Это единственный безопасный способ увидеть Толбачик; экстренно — 112.',
      'Самый безопасный способ увидеть вулкан — отложить поход и лететь вертолётом.',
    ]) expect(hasSafetyRanking(cut), cut).toBe(true);
  });

  it('живой выход ответа вырезает её на всех поверхностях', () => {
    expect(guardSafetyClaims(NIGHT_ANSWER, []).text).not.toMatch(/безопасный способ/);
    const out = finishKuzmichAnswer({ surface: 'web', answer: NIGHT_ANSWER, question: 'Какие туры на Толбачик у Местечка Камчатка?', toolRuns: [], context: '' });
    expect(out.text).not.toMatch(/безопасный способ/);
    expect(out.text).toContain('Вулкан Толбачик (вертолёт)');
  });

  it('уже показанный текст получает поправку словами', () => {
    const shown = correctShownAnswer({ surface: 'web', answer: NIGHT_ANSWER, question: 'туры на Толбачик', toolRuns: [], context: '' });
    expect(shown.tail).toContain(SHOWN_SAFETY_RANKING_CORRECTION);
  });
});

describe('эвал судит то же', () => {
  const CATALOG = ['РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:', T41, T73, T65, T51].join('\n');
  const refs = new Map<string, ReferenceResult>([
    [referenceKey(''), { ok: true, text: CATALOG }],
    [referenceKey('Толбачик'), { ok: true, text: TOLBACHIK }],
  ]);
  const budget: CommercialCheck[] = [{ kind: 'names_all_tours', query: 'Толбачик', max_price: 70000 }];
  const verdict = (answer: string, checks: CommercialCheck[]) =>
    judgeCommercial({ question: 'Есть тур на Толбачик дешевле 70 000?', answer, context: '', checks, references: refs });
  const kind = (v: ReturnType<typeof verdict>, k: string) => v.checks.find((c) => c.kind === k);

  it('«дешевле 70 000 нет», а ниже тот же тур — провал; с поправкой дописки — прошёл', () => {
    const lied = 'Туров на Толбачик дешевле 70 000 ₽ на платформе нет.\n\nЕщё по запросу на платформе:\n- «Вулкан Плоский Толбачик» — Край Вулканов, от 60 000 ₽/чел.';
    expect(kind(verdict(lied, budget), 'names_all_tours')?.outcome).toBe('fail');
    const fixed = completeTourList('Туров на Толбачик дешевле 70 000 ₽ на платформе нет.', 'Есть тур на Толбачик дешевле 70 000?', [{ query: 'толбачик', output: TOLBACHIK }], TOLBACHIK);
    expect(kind(verdict(fixed, budget), 'names_all_tours')?.outcome).toBe('pass');
  });

  it('выдуманная оценка безопасности — провал в любом вопросе, даже без записи в фикстуре', () => {
    const v = verdict('«Вулкан Плоский Толбачик» — Край Вулканов, 60 000 ₽. Это единственный безопасный способ увидеть Толбачик.', budget);
    expect(kind(v, 'no_safety_ranking')?.outcome).toBe('fail');
    expect(v.outcome).toBe('fail');
    const clean = verdict('«Вулкан Плоский Толбачик» — Край Вулканов, 60 000 ₽.', budget);
    expect(kind(clean, 'no_safety_ranking')?.outcome).toBe('pass');
  });
});

describe('5. 502 при выкате — один повтор, второй отказ красный', () => {
  const wf = load(readFileSync(join(process.cwd(), '.github/workflows/cron-kuzmich-eval.yml'), 'utf-8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => (s.run ?? '').includes('/api/cron/kuzmich-eval'));

  /** Настоящий bash шага; curl отвечает по очереди кодами из `codes`, sleep не ждёт. */
  function runStep(run: string, codes: string[]): { status: number; out: string; calls: number } {
    const dir = mkdtempSync(join(tmpdir(), 'eval-retry-'));
    const counter = join(dir, 'n');
    writeFileSync(counter, '0');
    writeFileSync(join(dir, 'codes'), codes.join('\n'));
    writeFileSync(join(dir, 'curl'), `#!/bin/bash
n=$(cat "${counter}"); n=$((n+1)); echo $n > "${counter}"
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then echo '{"ok":true}' > "$2"; fi; shift; done
sed -n "\${n}p" "${join(dir, 'codes')}"
`);
    writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n');
    writeFileSync(join(dir, 'jq'), '#!/bin/bash\nexit 0\n');
    for (const f of ['curl', 'sleep', 'jq']) chmodSync(join(dir, f), 0o755);
    let status = 0;
    let out = '';
    try {
      out = execFileSync('bash', ['-e', '-c', run], { env: { PATH: `${dir}:${process.env.PATH}`, CRON_SECRET: 'x' }, encoding: 'utf-8' });
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      status = err.status ?? 1;
      out = err.stdout ?? '';
    }
    const calls = existsSync(counter) ? Number(readFileSync(counter, 'utf-8').trim()) : 0;
    return { status, out, calls };
  }

  it('у каждого шага эвала повтор есть', () => {
    expect(steps).toHaveLength(3);
  });

  for (const [i, name] of ['фикстура', 'вопросы о турах', 'живые вопросы'].entries()) {
    it(`${name}: 502, затем 200 — зелёный за два вызова; 200 сразу — один вызов; 502 дважды — красный`, () => {
      const run = steps[i].run!;
      const retried = runStep(run, ['502', '200']);
      expect(retried.status).toBe(0);
      expect(retried.calls).toBe(2);
      expect(retried.out).toContain('повтор через 120 с');
      expect(runStep(run, ['200']).calls).toBe(1);
      const twice = runStep(run, ['502', '502']);
      expect(twice.status).not.toBe(0);
      expect(twice.calls).toBe(2);
      // 401 и 429 не повторяются: это не «сайт не ответил».
      const denied = runStep(run, ['429']);
      expect(denied.status).not.toBe(0);
      expect(denied.calls).toBe(1);
    });
  }
});
