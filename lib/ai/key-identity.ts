/**
 * lib/ai/key-identity.ts — какой именно ключ отвечал и откуда его спросили.
 *
 * Решение владельца 23.08.2026: ключи провайдеров в секретах GitHub и в
 * переменных Timeweb РАЗНЫЕ намеренно — «чтоб я сам понимал, откуда какой
 * работает». Замысел верный, но платформа его не поддерживала: диагностика
 * говорила «не ответил ни один провайдер», не называя ни ключа, ни места
 * запуска. Один и тот же код идёт и на раннере GitHub, и на проде Timeweb, и
 * два отчёта об отказе выглядели одинаково — то есть разные ключи ничего не
 * различали.
 *
 * Что здесь есть:
 *   - отпечаток ключа: восемь hex от SHA-256. Ключ по нему не восстановить,
 *     а два разных ключа различаются с первого взгляда. Секретом отпечаток не
 *     является и потому может стоять в отчёте, логе и на экране.
 *   - формат-маркер (`sk-or-v1`, `sk-`): это ПУБЛИЧНЫЙ признак семейства, он
 *     не приближает к значению ключа и отвечает на вопрос «а ключ ли это
 *     вообще» — 09.08 в переменную попадала строка из пробелов.
 *   - место запуска: раннер GitHub, прод или локальная машина.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ: самого ключа, его хвоста, его середины.
 * Отпечаток и длина отвечают на все нужные вопросы, ничего не раскрывая.
 * Сторож: `tests/unit/ai-key-identity.test.ts`.
 */

import { createHash } from 'crypto';

export type RunPlace = 'github-actions' | 'prod' | 'local' | 'unknown';

export interface KeyIdentity {
  /** Задан ли ключ. Строка из пробелов — НЕ задан. */
  present: boolean;
  /** Публичный формат-маркер или null, если он не распознан. */
  format: string | null;
  /** Длина значения после обрезки. Ноль — пустое значение. */
  length: number;
  /** Восемь hex от SHA-256. null — ключа нет, отпечатывать нечего. */
  fingerprint: string | null;
}

/** Известные публичные префиксы. Секретной части в них нет. */
const FORMATS = ['sk-or-v1-', 'sk-ant-', 'sk-', 'AIza'] as const;

/**
 * Отпечаток ключа — столько, сколько нужно, чтобы отличить один от другого,
 * и ни символа сверх того.
 */
export function keyIdentity(raw: string | undefined | null): KeyIdentity {
  const value = (raw ?? '').trim();
  if (value === '') {
    // «Не задан» и «задан пустой строкой» для человека одно и то же, а вот
    // «задан пробелами» выглядел как заданный — на этом 09.08 потеряли день.
    return { present: false, format: null, length: 0, fingerprint: null };
  }
  const format = FORMATS.find((p) => value.startsWith(p)) ?? null;
  return {
    present: true,
    format,
    length: value.length,
    fingerprint: createHash('sha256').update(value).digest('hex').slice(0, 8),
  };
}

/**
 * Где выполняется код. Отвечает на «откуда спросили»: у раннера и у прода
 * разные ключи, и без этого поля два отчёта об отказе неразличимы.
 */
export function runPlace(env: NodeJS.ProcessEnv = process.env): RunPlace {
  if (env.GITHUB_ACTIONS === 'true') return 'github-actions';
  if (env.NODE_ENV === 'production') return 'prod';
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return 'local';
  return 'unknown';
}

export const RUN_PLACE_LABELS: Record<RunPlace, string> = {
  'github-actions': 'раннер GitHub (ключ из секретов репозитория)',
  prod: 'прод Timeweb (ключ из переменных приложения)',
  local: 'локальная машина (.env.local)',
  unknown: 'место запуска не определено',
};

/** Ключи, о которых спрашивают чаще всего, — в одном месте, чтобы не разъезжались. */
export const TRACKED_KEYS = [
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  { id: 'deepseek',   label: 'DeepSeek',   env: 'DEEPSEEK_API_KEY' },
  { id: 'dashscope',  label: 'Qwen',       env: 'DASHSCOPE_API_KEY' },
  { id: 'anthropic',  label: 'Anthropic',  env: 'ANTHROPIC_API_KEY' },
  { id: 'gemini',     label: 'Gemini',     env: 'GEMINI_API_KEY' },
] as const;

export interface KeyReport {
  id: string;
  label: string;
  env: string;
  identity: KeyIdentity;
}

/** Снимок всех отслеживаемых ключей — что задано и чем именно. */
export function keyReport(env: NodeJS.ProcessEnv = process.env): KeyReport[] {
  return TRACKED_KEYS.map((k) => ({
    id: k.id, label: k.label, env: k.env,
    identity: keyIdentity(env[k.env]),
  }));
}

/** Одна строка для лога и отчёта CI: место, ключ, отпечаток. */
export function formatKeyLine(r: KeyReport, place: RunPlace): string {
  if (!r.identity.present) return `${r.label}: ${r.env} не задан (${RUN_PLACE_LABELS[place]})`;
  const fmt = r.identity.format ?? 'формат не распознан';
  return `${r.label}: отпечаток ${r.identity.fingerprint}, ${fmt}, ${r.identity.length} симв. (${RUN_PLACE_LABELS[place]})`;
}
