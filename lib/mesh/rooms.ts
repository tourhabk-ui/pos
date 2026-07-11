/**
 * Геокомнаты VolcanoMesh — общий модуль для клиента (volcano-mesh.ts)
 * и сервера (signaling-store.ts).
 *
 * Ячейка — 0.1° по широте и долготе (на широте Камчатки ~11 x 6.5 км).
 * Устройство регистрируется в своей ячейке, но видит соседей из 3x3
 * блока ячеек: без этого два туриста в 100 метрах по разные стороны
 * границы ячейки не находили друг друга.
 */

export function roomOf(lat: number, lng: number): string {
  return `vol-${Math.floor(lat * 10)}-${Math.floor(lng * 10)}`;
}

const ROOM_RE = /^vol-(-?\d+)-(-?\d+)$/;

/**
 * Своя комната + 8 соседних (3x3). При нераспознанном имени комнаты —
 * только она сама (деградация без падения).
 */
export function neighborRooms(room: string): string[] {
  const m = ROOM_RE.exec(room);
  if (!m) return [room];
  const x = parseInt(m[1]!, 10);
  const y = parseInt(m[2]!, 10);
  const rooms: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      rooms.push(`vol-${x + dx}-${y + dy}`);
    }
  }
  return rooms;
}

/**
 * Комнаты смежны, если входят в 3x3 блок друг друга (расстояние Чебышёва <=1).
 * Без аллокаций — вызывается в цикле по всем соединениям на каждый broadcast.
 * Нераспознанные имена смежны только сами с собой.
 */
export function roomsAreNeighbors(a: string, b: string): boolean {
  if (a === b) return true;
  const ma = ROOM_RE.exec(a);
  const mb = ROOM_RE.exec(b);
  if (!ma || !mb) return false;
  return (
    Math.abs(parseInt(ma[1]!, 10) - parseInt(mb[1]!, 10)) <= 1 &&
    Math.abs(parseInt(ma[2]!, 10) - parseInt(mb[2]!, 10)) <= 1
  );
}
