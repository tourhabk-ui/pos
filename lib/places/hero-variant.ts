/**
 * Веб-копия главного фото места из снимка туриста.
 *
 * Перенос в герои (lib/places/user-photo-hero) ставил ссылкой ОРИГИНАЛ
 * загрузки — до 10 МБ и 3000x4000. Аудит 01.10: главная весила 8,7 МБ на
 * телефоне, 6,1 из них — один такой герой. Здесь — одна дорога к лёгкой
 * копии и для нового переноса, и для починки уже перенесённых
 * (/api/cron/hero-web-variant). Оригинал не трогается и остаётся в
 * source_url: копия — производная, её можно пересоздать.
 */
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { fetchSource, makeWebVariant, uploadVerified, WEB_VARIANT, type VariantSize } from '@/lib/images/web-variant';

export type HeroVariantOutcome =
  | { status: 'made'; url: string; key: string; width: number; height: number; wasBytes: number; nowBytes: number }
  | { status: 'not_needed'; reason: string }
  | { status: 'failed'; reason: string };

/** Ключ копии: место и снимок, из которого она сделана, — пересоздание ложится на тот же ключ. */
export function heroVariantKey(arkId: string, sourceId: string): string {
  return `place-heroes/${arkId}/${sourceId}-1280.jpg`;
}

/**
 * Ключ копии тяжёлого снимка, уехавшего в хранилище байтами как был
 * (/api/cron/hero-web-variant, scope oversize): рядом с прежним объектом.
 */
export function oversizeVariantKey(arkId: string, imageId: string): string {
  return `places/${arkId}/${imageId}-1280.jpg`;
}

/** Ключ копии для карточки (scope thumb): рядом с объектом снимка. */
export function thumbVariantKey(arkId: string, imageId: string): string {
  return `places/${arkId}/${imageId}-480.jpg`;
}

export async function heroVariantFor(sourceUrl: string, key: string, size: VariantSize = WEB_VARIANT): Promise<HeroVariantOutcome> {
  if (!isS3Configured) return { status: 'failed', reason: 'хранилище не настроено' };
  const src = await fetchSource(sourceUrl);
  if (src.buf === null) return { status: 'failed', reason: src.reason };
  const variant = await makeWebVariant(src.buf, size);
  if (variant.status !== 'made') return variant;
  const up = await uploadVerified(key, variant.buf, uploadToS3);
  if (up.url === null) return { status: 'failed', reason: up.reason };
  return {
    status: 'made',
    url: up.url,
    key: up.key,
    width: variant.width,
    height: variant.height,
    wasBytes: src.buf.length,
    nowBytes: variant.buf.length,
  };
}
