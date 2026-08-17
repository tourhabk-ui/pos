/**
 * Публикация во второй канал наблюдаема: исход считается, хранится и сторожится.
 *
 * Владелец 17.08: «нет публикаций в канале @ai_hub_money, хотя мы делали
 * расписание». Ничего отключено не было. Крон шёл зелёным две недели подряд,
 * `digest_sent` был `true` — и всё это правда: дайджест уходил, только в
 * ДРУГОЙ канал.
 *
 * AI-пост живёт внутри того же прогона, но после всех фактчек-гейтов. Любой
 * ранний выход — нет свежих сигналов, синтез пуст, судья промолчал, выпуск
 * повторяет вчерашний — обрывал функцию до него, а причина записывалась про
 * основной канал. И даже дойдя до отправки, результат выбрасывался:
 * `await tgSendRich(...)` без присваивания. Отказ Telegram (бот не админ
 * канала, разметка не принята) не оставлял следа нигде.
 *
 * Три звена одной цепи, и сторожатся все три: исход считается в коде,
 * сохраняется в артефакт, и по артефакту его читает health. Разорвись любое —
 * канал снова замолчит незаметно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-digest';

const ROOT = process.cwd();
const DIGEST = readFileSync(join(ROOT, 'lib/agents/scout-digest.ts'), 'utf-8');
const HEALTH = readFileSync(join(ROOT, 'app/api/cron/health/route.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/cron-scout-digest.yml'), 'utf-8');

/** Код без комментариев: прежний дефект в них разобран намеренно. */
const DIGEST_CODE = DIGEST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('исход отправки не выбрасывается', () => {
  it('результат tgSendRich присваивается', () => {
    // `await tgSendRich(...)` отдельным выражением — ровно тот дефект.
    expect(DIGEST_CODE).toMatch(/aiSent = await tgSendRich\(/);
    expect(DIGEST_CODE).not.toMatch(/^\s*await tgSendRich\(/m);
  });

  it('неудача отправки получает причину', () => {
    expect(DIGEST_CODE).toMatch(/ai_send_failed/);
  });

  it('исход уезжает в результат прогона', () => {
    expect(DIGEST_CODE).toMatch(/ai_channel_sent: aiSent/);
    expect(DIGEST_CODE).toMatch(/ai_channel_skip_reason: aiSkip/);
  });
});

describe('у каждого раннего выхода своя причина', () => {
  const CODES = [
    'ai_channel_not_configured',
    'ai_no_items',
    'ai_synthesis_null',
    'ai_unsourced_percents',
    'ai_factcheck_failed',
    'ai_send_failed',
    'ai_digest_aborted',
  ];

  it('все причины названы человеческим языком', () => {
    // Код `ai_factcheck_failed` в алерте владельцу значит столько же, сколько
    // молчание: чтобы понять, надо лезть в исходник.
    for (const c of CODES) {
      expect(SKIP_REASON_LABELS[c], `нет подписи для ${c}`).toBeTruthy();
    }
  });

  it('каждая причина где-то присваивается', () => {
    for (const c of CODES) {
      expect(DIGEST_CODE, `причина ${c} объявлена, но не используется`).toMatch(new RegExp(`'${c}'`));
    }
  });

  it('состояние «прогон не дошёл» отличимо от «не отправили по причине»', () => {
    // Стартовое значение — именно ai_digest_aborted: если функция оборвётся
    // раньше блока, исход не притворится успехом и не притворится отказом
    // отправки.
    expect(DIGEST_CODE).toMatch(/let aiSkip: string \| undefined = 'ai_digest_aborted'/);
  });
});

describe('health видит молчание второго канала', () => {
  it('читает исход из артефакта, а не гадает по свежести выпуска', () => {
    expect(HEALTH).toMatch(/ai_channel_sent/);
    expect(HEALTH).toMatch(/SELECT slug, metadata FROM agent_knowledge/);
  });

  it('алертит, когда пост не ушёл при свежем выпуске', () => {
    expect(HEALTH).toMatch(/AI-канал молчит/);
  });

  it('называет причину словами, а не кодом', () => {
    expect(HEALTH).toMatch(/SKIP_REASON_LABELS\[aiSkip\]/);
  });

  it('отсутствие записи о канале тоже произносится вслух', () => {
    expect(HEALTH).toMatch(/причина не записана/);
  });
});

describe('пропуск задачи не выглядит успехом', () => {
  it('без CRON_SECRET прогон краснеет', () => {
    const guard = WF.slice(WF.indexOf('if [ -z "$CRON_SECRET" ]'));
    expect(guard.slice(0, 300)).toMatch(/exit 1/);
    expect(guard.slice(0, 300)).not.toMatch(/exit 0/);
  });
});
