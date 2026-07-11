/**
 * Синтетический IPv6-ключ пострадавшего для форварда меш-SOS.
 *
 * Канонический /api/safety/sos (§7, не трогаем) rate-limit'ит 1 SOS / 10 мин
 * по IP и пишет ip_address с кастом ::inet. Если форвардить с IP ретранслятора,
 * один занятой онлайн-узел глушил бы SOS второго пострадавшего в группе.
 * Поэтому ключ — валидный IPv6 (ULA fd00::/8), детерминированно выведенный
 * из идентификатора УСТРОЙСТВА-ОТПРАВИТЕЛЯ: одна жертва — один ключ,
 * разные жертвы — разные ключи.
 */

function djb2hex(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function syntheticVictimIp(deviceId: string): string {
  const id = deviceId || 'unknown-device';
  let hex = id.replace(/[^0-9a-f]/gi, '').toLowerCase();
  // Не-UUID или короткий id — детерминированно добиваем хэшами
  let salt = 0;
  while (hex.length < 30) {
    hex += djb2hex(`${id}:${salt++}`);
  }
  const body = hex.slice(0, 30);
  const groups: string[] = ['fd' + body.slice(0, 2)];
  for (let i = 2; i < 30; i += 4) {
    groups.push(body.slice(i, i + 4));
  }
  return groups.join(':');
}
