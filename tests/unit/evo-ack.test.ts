/**
 * Сторож: подтверждение приёма не притворяется результатом.
 *
 * ── Что случилось 29.08 ───────────────────────────────────────────────────
 *
 * Джоб Evo на cron-job.org отметился как «Провалено (тайм-аут)» в 18:00 —
 * при том, что сервер работу ДОДЕЛАЛ. Полный прогон идёт до 300 секунд
 * (maxDuration роута), воркфлоу GitHub столько терпит (--max-time 300), а
 * внешний планировщик рвёт связь много раньше.
 *
 * Это уже знакомая беда: та же запись есть в шапке cron-scout-digest.yml —
 * раннер бросал трубку с exit 28, сервер дайджест доделывал и в Telegram
 * отправлял. Красный прогон при выполненной работе хуже бесполезного: он
 * учит не верить красному.
 *
 * ── Чем лечится и чем лечить НЕЛЬЗЯ ───────────────────────────────────────
 *
 * Ответом 202 «принято». Но именно здесь легко солгать: ответить успехом,
 * которого ещё нет. Поэтому тело говорит `accepted`, а не `success`, и несёт
 * kernel_task_id — исход ищется по нему.
 *
 * И режим обязан включаться ЯВНО. Молча сменить смысл ответа нельзя:
 * воркфлоу GitHub читает success/status из тела и краснеет на partial — для
 * него ответ без результата стал бы вечнозелёным прогоном, то есть ровно
 * тем, от чего лечимся.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/evo/route.ts'), 'utf-8');
const SYNC = readFileSync(join(process.cwd(), '.github/workflows/cronjob-sync.yml'), 'utf-8');

describe('ack=1 подтверждает приём, а не успех', () => {
  it('режим включается явным параметром, а не по умолчанию', () => {
    expect(SRC).toMatch(/searchParams\.get\('ack'\) === '1'/);
  });

  it('ответ — 202, а не 200', () => {
    // 200 читается как «сделано». Работа в этот момент только началась.
    expect(SRC).toMatch(/status: 202/);
  });

  it('тело не обещает success', () => {
    const at = SRC.indexOf("searchParams.get('ack')");
    expect(at).toBeGreaterThan(0);
    const block = SRC.slice(at, at + 700);
    expect(block).toContain('accepted: true');
    expect(block, 'подтверждение приёма выдано за успех').not.toMatch(/success:\s*true/);
  });

  it('исход остаётся находимым', () => {
    const at = SRC.indexOf("searchParams.get('ack')");
    const block = SRC.slice(at, at + 700);
    expect(block).toContain('kernel_task_id');
  });
});

describe('оба пути прогона — один код', () => {
  it('и ожидающий, и фоновый зовут runAndRecord', () => {
    // Две копии неизбежно разойдутся в записи истории или в снятии замка —
    // такие расхождения уже стоили нам карточки тура и SOS-кнопки.
    const calls = SRC.match(/runAndRecord\(/g) ?? [];
    expect(calls.length, 'путей стало больше одного').toBeGreaterThanOrEqual(3);
  });

  it('замок снимается внутри общего пути, а не в каждом вызывающем', () => {
    const at = SRC.indexOf('async function runAndRecord');
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(at)).toMatch(/finally\s*\{\s*await releaseEvoRunLock\(lock\)/);
  });

  it('фоновый прогон не роняет процесс необработанным отказом', () => {
    expect(SRC).toMatch(/runAndRecord\([^)]*\)\.catch\(/);
  });
});

describe('сверка джобов предупреждает о заведомом тайм-ауте', () => {
  it('видит evo без ack=1', () => {
    expect(SYNC).toMatch(/ack=1/);
    expect(SYNC).toMatch(/::warning::Джоб evo без ack=1/);
  });

  it('только предупреждает — чужой джоб не переписывает', () => {
    // apply намеренно ничего не меняет в существующих джобах: панель у
    // владельца одна, и правка адреса рабочего джоба — его решение.
    const at = SYNC.indexOf('Долгие прогоны без подтверждения');
    const block = SYNC.slice(at, at + 900);
    expect(block).not.toMatch(/-X (PATCH|PUT)/);
  });
});
