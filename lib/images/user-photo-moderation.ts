/**
 * lib/images/user-photo-moderation.ts — агент модерации снимков туристов.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Снимки, которые туристы загружают на карточку места (user_place_photos),
 * до 04.10 модерировал только человек на /hub/admin/user-photos, и ни одно
 * из правил наших фото мест (дубль по dHash, водяной знак, род места) их не
 * касалось. Решение владельца 04.10: модерирует агент по расписанию, сам
 * одобряет и отклоняет; «после первых пяти проверим».
 *
 * ── Правило решения ───────────────────────────────────────────────────────
 *
 * Зрение (то же, что у photo-audit) отвечает на четыре вопроса, у каждого
 * три исхода (§4.0). Решает этот модуль, а не модель:
 *
 *   отклонить   — дубль, водяной знак/фотосток, недопустимое, или «не тот
 *                 род места» (вулкан под подписью озера);
 *   одобрить    — все четыре ответа чистые и дубля нет;
 *   человеку    — всё остальное: хоть одно «не знаю», люди крупным планом.
 *
 * «Не знаю» не равно «чисто»: снимок с непрочитанным ответом остаётся в
 * очереди человеку, а не публикуется.
 */
import type { VisionResult } from '@/lib/ai/providers';
import type { ThreeWay } from '@/lib/images/photo-audit';

export type AgentDecision = 'approved' | 'rejected' | 'human';

export interface UserPhotoVerdict {
  depicts: string;
  watermark: ThreeWay;
  matchesType: ThreeWay;
  /** Лица людей крупным планом — чужие персональные данные (152-ФЗ). */
  peopleCloseup: ThreeWay;
  /** Непристойное, насилие, реклама, скриншот, текст вместо снимка. */
  inappropriate: ThreeWay;
  raw?: string;
  provider: string | null;
  model: string | null;
}

/** Вопрос зрению. Только то, что видно на кадре; конкретное место не угадывать. */
export function userPhotoPrompt(placeName: string, typeLabel: string): string {
  return [
    `Турист загрузил снимок к месту «${placeName}», род места — ${typeLabel}.`,
    'Ответь строго JSON без пояснений, ключи:',
    '"depicts" — что изображено, одна короткая фраза по-русски;',
    '"watermark" — есть ли водяной знак, логотип или надпись фотобанка: "yes", "no" или "unknown";',
    '"matches_type" — похоже ли изображённое на такой род места: "yes", "no" или "unknown";',
    '"people_closeup" — есть ли на кадре лица людей крупным планом, по которым человека можно узнать: "yes", "no" или "unknown";',
    '"inappropriate" — непристойное, насилие, реклама, скриншот экрана или картинка с текстом вместо фотографии: "yes", "no" или "unknown".',
    'Если не уверен — пиши "unknown", не угадывай. Конкретное место по снимку не определяй.',
  ].join(' ');
}

const THREE = new Set(['yes', 'no', 'unknown']);
const three = (v: unknown): ThreeWay => (typeof v === 'string' && THREE.has(v) ? (v as ThreeWay) : 'unknown');

/** Разбор ответа: не JSON или не те ключи — всё «unknown», сырой текст сохраняется. */
export function parseUserPhotoVerdict(result: Pick<VisionResult, 'text' | 'legs'>): UserPhotoVerdict {
  const ok = result.legs.find((l) => l.outcome === 'ok');
  const base = { provider: ok?.provider ?? null, model: ok?.model ?? null };
  const blank = { depicts: '', watermark: 'unknown', matchesType: 'unknown', peopleCloseup: 'unknown', inappropriate: 'unknown' } as const;
  const text = (result.text ?? '').trim();
  if (!text) return { ...blank, ...base };
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ...blank, raw: text.slice(0, 500), ...base };
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    return {
      depicts: typeof j.depicts === 'string' ? j.depicts.slice(0, 300) : '',
      watermark: three(j.watermark),
      matchesType: three(j.matches_type),
      peopleCloseup: three(j.people_closeup),
      inappropriate: three(j.inappropriate),
      ...base,
    };
  } catch {
    return { ...blank, raw: text.slice(0, 500), ...base };
  }
}

/** Решение и причина словами (для журнала, админа и туриста). */
export function decideUserPhoto(
  v: Pick<UserPhotoVerdict, 'watermark' | 'matchesType' | 'peopleCloseup' | 'inappropriate'>,
  duplicateOf: string | null,
): { decision: AgentDecision; reason: string } {
  if (duplicateOf) return { decision: 'rejected', reason: `повтор уже имеющегося снимка (${duplicateOf})` };
  if (v.watermark === 'yes') return { decision: 'rejected', reason: 'водяной знак или снимок фотобанка' };
  if (v.inappropriate === 'yes') return { decision: 'rejected', reason: 'недопустимое содержимое или не фотография' };
  if (v.matchesType === 'no') return { decision: 'rejected', reason: 'на снимке не этот род места' };
  if (v.peopleCloseup === 'yes') return { decision: 'human', reason: 'люди крупным планом — решает человек' };
  const unknown = (['watermark', 'matchesType', 'peopleCloseup', 'inappropriate'] as const).filter((k) => v[k] !== 'no' && v[k] !== 'yes');
  if (unknown.length > 0 || v.matchesType !== 'yes') {
    return { decision: 'human', reason: `зрение не уверено (${unknown.join(', ') || 'matchesType'}) — решает человек` };
  }
  return { decision: 'approved', reason: 'чистый снимок этого рода места, не повтор' };
}
