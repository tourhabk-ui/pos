'use client';

import { useEffect } from 'react';

/**
 * Учёт установок PWA. Раньше платформа не считала, сколько раз приложение
 * поставили на телефон. Здесь фиксируем УСТРОЙСТВА (дедуп по анонимному
 * client_id в localStorage — случайный UUID, не ПД).
 *
 * Два честных сигнала:
 *  - appinstalled — событие браузера при установке (Android/Chrome);
 *  - запуск в standalone-режиме — единственный способ увидеть iOS Safari,
 *    который appinstalled не шлёт.
 *
 * Шлём максимум раз за сессию на каждый источник (sessionStorage-флаг), чтобы
 * не долбить эндпоинт на каждую навигацию. Всё тихо: аналитика не мешает UX.
 */

const CLIENT_ID_KEY = 'pwa-client-id';

function getClientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

function detectPlatform(): 'android' | 'ios' | 'desktop' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  if (/android/.test(ua)) return 'android';
  if (/iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && 'ontouchend' in document)) return 'ios';
  if (/windows|macintosh|linux|x11/.test(ua)) return 'desktop';
  return 'unknown';
}

function isStandalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function report(source: 'appinstalled' | 'standalone-launch') {
  const clientId = getClientId();
  if (!clientId) return;
  // Один сигнал каждого типа за сессию — остального не нужно для счёта устройств.
  const flag = `pwa-reported-${source}`;
  try {
    if (sessionStorage.getItem(flag)) return;
    sessionStorage.setItem(flag, '1');
  } catch { /* приватный режим — просто отправим один раз */ }

  const body = JSON.stringify({ clientId, platform: detectPlatform(), source });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/pwa/install', new Blob([body], { type: 'application/json' }));
      return;
    }
  } catch { /* упадём на fetch ниже */ }
  fetch('/api/pwa/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => { /* тихо */ });
}

export function InstallTracker() {
  useEffect(() => {
    // Уже установлено и открыто как приложение — считаем устройство (в т.ч. iOS).
    if (isStandalone()) report('standalone-launch');

    // Явное событие установки (Android/Chrome) — самый сильный сигнал.
    const onInstalled = () => report('appinstalled');
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  return null;
}
