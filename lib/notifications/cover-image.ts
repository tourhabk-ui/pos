/**
 * Умная обложка новостного поста канала.
 *
 * До этого обложку рисовал только Pollinations (`flux`) по ДЕТЕРМИНИРОВАННОМУ
 * промпту из хэша текста (`post-image.ts`): сюжет выпадал случайно из 12
 * заготовок и про смысл новости не знал — «красная роборука» на пост про закон
 * об ИИ. Здесь добавлен второй, «понимающий» путь: image-модель Alibaba
 * DashScope (Qwen-Image / wan-*), которой мы сначала LLM-ом сочиняем осмысленный
 * визуальный промпт по заголовку новости (символическая сцена, без лиц и текста),
 * а затем она его рисует.
 *
 * ВКЛючается ОСОЗНАННО через env `QWEN_IMAGE_MODEL` (ключ `DASHSCOPE_API_KEY`
 * уже есть для текстового Qwen). Пока модель не задана — поведение прежнее
 * (Pollinations), ноль изменений и риска. Любой сбой умного пути (нет ключа,
 * таймаут, отказ задачи) — тихий откат на Pollinations: обложка выходит всегда.
 *
 * 152-ФЗ: в промпт идёт ТОЛЬКО публичный текст новости, не ПД туриста, поэтому
 * трансграничной передачи ПД тут нет. Хост DashScope всё равно внесён в реестр
 * провайдеров (D2) как зарубежный сток — осознанно.
 */

import {
  aiNewsImagePrompt,
  travelNewsImagePrompt,
  themeHint,
} from '@/lib/notifications/post-image';
import { buildPollinationsUrl } from '@/lib/services/ingest/pollinations-url';
import { callAIFastOrNull } from '@/lib/ai/providers';

export type CoverChannel = 'ai' | 'travel';

export interface CoverImage {
  url: string;
  source: 'qwen-image' | 'pollinations';
  prompt: string;
}

const DASHSCOPE_IMAGE_HOST = 'https://dashscope-intl.aliyuncs.com';

/**
 * Конфиг image-модели DashScope. Модель ПУСТА по умолчанию — фича opt-in:
 * владелец задаёт `QWEN_IMAGE_MODEL` под то, что включено в его аккаунте
 * (напр. `wan2.2-t2i-flash` / `wanx2.1-t2i-turbo` / `qwen-image`), и путь
 * активируется. Хост/размер — тоже из env, без хардкода id (см. §8 CLAUDE.md).
 */
export function getDashScopeImageConfig(): {
  apiKey: string | null;
  base: string;
  model: string;
  size: string;
} {
  return {
    apiKey: process.env.DASHSCOPE_API_KEY || null,
    base: (process.env.QWEN_IMAGE_BASE || DASHSCOPE_IMAGE_HOST).replace(/\/+$/, ''),
    model: process.env.QWEN_IMAGE_MODEL || '',
    size: process.env.QWEN_IMAGE_SIZE || '1280*720',
  };
}

/** Умный путь активен только когда есть и ключ, и явно заданная модель. */
export function dashScopeImageEnabled(): boolean {
  const { apiKey, model } = getDashScopeImageConfig();
  return Boolean(apiKey && model);
}

const AI_SCENE_SYSTEM =
  'You are an art director for a tech-news channel. Turn the given news headline ' +
  'into ONE concise English text-to-image prompt for a single symbolic editorial ' +
  'illustration that conveys the meaning of the news. Hard rules: no text, no ' +
  'words, no letters, no logos, no watermarks in the image; do NOT depict real ' +
  'people, politicians or recognizable faces; prefer symbolic objects and scenes; ' +
  'cinematic, high detail. Output ONLY the prompt, one line, at most 60 words.';

const TRAVEL_SCENE_SYSTEM =
  'You are an art director for a Kamchatka travel channel. Turn the given news ' +
  'headline into ONE concise English text-to-image prompt for a single evocative ' +
  'landscape photograph of Kamchatka wild nature (volcanoes, ocean, taiga) that ' +
  'fits the news. Hard rules: no text, no logos, no watermarks; no people; ' +
  'National Geographic style, cinematic. Output ONLY the prompt, one line, at ' +
  'most 60 words.';

/**
 * Сочиняет визуальный промпт по заголовку новости через быстрый текстовый
 * водопад. При отказе LLM — детерминированный фолбэк (существующий генератор),
 * чтобы умный путь никогда не падал из-за недоступности текстовой модели.
 */
export async function composeCoverPrompt(text: string, channel: CoverChannel): Promise<string> {
  const headline = themeHint(text);
  const system = channel === 'ai' ? AI_SCENE_SYSTEM : TRAVEL_SCENE_SYSTEM;
  try {
    const out = await callAIFastOrNull([
      { role: 'system', content: system },
      { role: 'user', content: headline },
    ]);
    const cleaned = out?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned && cleaned.length >= 15) return cleaned.slice(0, 480);
  } catch {
    /* откат ниже */
  }
  return channel === 'ai' ? aiNewsImagePrompt(text) : travelNewsImagePrompt(text);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const NEGATIVE_PROMPT =
  'text, words, letters, watermark, logo, signature, caption, blurry, deformed, extra limbs';

/**
 * Рисует картинку через async text2image DashScope: создать задачу → опрашивать
 * статус до SUCCEEDED. Возвращает URL картинки (OSS, живёт ~24ч — потребитель
 * успевает забрать) либо null при любом сбое/таймауте. Экспортируется для
 * переиспользования (обложки постов + фото точек через ai-image-generator).
 */
export async function generateQwenImageUrl(prompt: string): Promise<string | null> {
  const { apiKey, base, model, size } = getDashScopeImageConfig();
  if (!apiKey || !model) return null;

  let taskId: string | null = null;
  try {
    const createRes = await fetch(
      `${base}/api/v1/services/aigc/text2image/image-synthesis`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify({
          model,
          input: { prompt: prompt.slice(0, 800), negative_prompt: NEGATIVE_PROMPT },
          parameters: { size, n: 1 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!createRes.ok) return null;
    const created = (await createRes.json()) as { output?: { task_id?: string } };
    taskId = created?.output?.task_id ?? null;
  } catch {
    return null;
  }
  if (!taskId) return null;

  // Поллинг: держимся заметно ниже 60с (лимит эндпоинта и curl в workflow).
  const pollMs = Number(process.env.QWEN_IMAGE_POLL_MS) || 2500;
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const pollRes = await fetch(`${base}/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!pollRes.ok) continue;
      const data = (await pollRes.json()) as {
        output?: { task_status?: string; results?: Array<{ url?: string }> };
      };
      const status = data?.output?.task_status;
      if (status === 'SUCCEEDED') {
        return data.output?.results?.find((r) => r.url)?.url ?? null;
      }
      if (status === 'FAILED' || status === 'UNKNOWN') return null;
    } catch {
      /* сетевой всхлип — пробуем ещё раз до дедлайна */
    }
  }
  return null;
}

/**
 * Главная точка входа: вернуть URL обложки. Умный путь (DashScope) —
 * когда включён и не подавлен; иначе детерминированный Pollinations. Всегда
 * возвращает рабочий URL, никогда не бросает.
 *
 * @param opts.explicitPrompt — явный промпт из триггера (минует LLM-сочинение).
 * @param opts.skipSmartImage — форсировать Pollinations (быстрый тест-режим).
 */
export async function resolveCoverImage(
  text: string,
  channel: CoverChannel,
  seed: number,
  opts: { explicitPrompt?: string; skipSmartImage?: boolean } = {},
): Promise<CoverImage> {
  const deterministicPrompt =
    opts.explicitPrompt ??
    (channel === 'ai' ? aiNewsImagePrompt(text) : travelNewsImagePrompt(text));

  if (!opts.skipSmartImage && dashScopeImageEnabled()) {
    const smartPrompt = opts.explicitPrompt ?? (await composeCoverPrompt(text, channel));
    const url = await generateQwenImageUrl(smartPrompt);
    if (url) return { url, source: 'qwen-image', prompt: smartPrompt };
  }

  return {
    url: buildPollinationsUrl(deterministicPrompt, seed, 1280, 720),
    source: 'pollinations',
    prompt: deterministicPrompt,
  };
}
