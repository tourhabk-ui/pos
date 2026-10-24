/**
 * Адрес нашего сервера — свой визит, не турист (владелец 24.10).
 *
 * Сравниваем уже разобранный адрес запроса со множеством адресов коробки:
 * петля, адреса интерфейсов этого процесса и список VEDAR_BOX_IPS (публичный
 * адрес за NAT, которого на интерфейсе нет). Сырой адрес в журнал не пишется:
 * наружу уходит только «свой / не свой».
 *
 * Адреса нет (заголовок не пришёл) — это не коробка. Подставлять 127.0.0.1
 * за отсутствующий заголовок значило бы записать всех таких гостей своими.
 */
import { networkInterfaces } from 'os';

export function normalizeIp(ip: string): string {
  return ip.trim().toLowerCase().replace(/^::ffff:/, '');
}

/** Петля, адреса интерфейсов и явный список. Пустая строка в списке — не адрес. */
export function platformBoxAddresses(envList: string | undefined, hostIps: readonly string[]): Set<string> {
  const set = new Set<string>(['127.0.0.1', '::1']);
  for (const ip of hostIps) {
    const n = normalizeIp(ip);
    if (n) set.add(n);
  }
  for (const part of (envList ?? '').split(',')) {
    const n = normalizeIp(part);
    if (n) set.add(n);
  }
  return set;
}

function hostIps(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.address) out.push(info.address);
      }
    }
  } catch (err) {
    console.error('[box-ip] интерфейсы не прочитаны:', err instanceof Error ? err.message : 'ошибка');
  }
  return out;
}

let cached: { env: string | undefined; set: Set<string> } | null = null;

function liveBoxAddresses(): Set<string> {
  const env = process.env.VEDAR_BOX_IPS;
  if (cached && cached.env === env) return cached.set;
  const set = platformBoxAddresses(env, hostIps());
  cached = { env, set };
  return set;
}

export function isPlatformBoxIp(ip: string | null | undefined, known?: ReadonlySet<string>): boolean {
  if (!ip) return false;
  const n = normalizeIp(ip);
  if (!n) return false;
  return (known ?? liveBoxAddresses()).has(n);
}
