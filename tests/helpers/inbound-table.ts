/**
 * chat_inbound_seen в памяти теста (миграции 1448, 1449): тот же смысл, что у
 * запросов lib/chat/inbound-seen на настоящем PostgreSQL (сверено в PR #3433).
 * handle() отвечает на запросы этой таблицы и null — на чужие.
 */
export interface InboundRow {
  hits: number; boot_id: string | null; processed: boolean; attempts: number; payload: unknown; ageMin: number;
}

export function createInboundTable() {
  const rows = new Map<string, InboundRow>();
  const id = (s: unknown, key: unknown) => `${String(s)}:${String(key)}`;
  let failing: Error | null = null;

  function handle(sql: unknown, p: unknown[] = []): { rows: unknown[] } | null {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    if (!q.includes('chat_inbound_seen')) return null;
    if (failing) throw failing;
    if (q.startsWith('INSERT INTO chat_inbound_seen')) {
      const row = rows.get(id(p[0], p[1]));
      if (row) row.hits += 1;
      else rows.set(id(p[0], p[1]), {
        hits: 1, boot_id: String(p[2]), processed: false, attempts: 0,
        payload: p[3] === null || p[3] === undefined ? null : JSON.parse(String(p[3])), ageMin: 0,
      });
      const r = rows.get(id(p[0], p[1]))!;
      return { rows: [{ hits: r.hits, boot_id: r.boot_id, processed: r.processed, attempts: r.attempts, fresh: r.ageMin < Number(p[4]) }] };
    }
    if (q.startsWith('UPDATE chat_inbound_seen SET boot_id = $3')) {
      const r = rows.get(id(p[0], p[1]));
      if (!r || r.processed || r.boot_id === p[2] || r.attempts >= 1 || r.ageMin >= Number(p[3])) return { rows: [] };
      r.boot_id = String(p[2]); r.attempts += 1;
      return { rows: [{ taken: 1 }] };
    }
    if (q.startsWith('UPDATE chat_inbound_seen SET processed_at = now(), payload = NULL')) {
      const r = rows.get(id(p[0], p[1]));
      if (r && r.boot_id === p[2] && !r.processed) { r.processed = true; r.payload = null; }
      return { rows: [] };
    }
    if (q.startsWith('UPDATE chat_inbound_seen SET payload = NULL')) {
      for (const r of rows.values()) if (r.payload !== null && r.ageMin >= Number(p[0])) r.payload = null;
      return { rows: [] };
    }
    if (q.startsWith('UPDATE chat_inbound_seen c SET boot_id = $1')) {
      const out: Array<{ update_key: string; payload: unknown }> = [];
      for (const [rowId, r] of rows) {
        const cut = rowId.indexOf(':');
        const source = rowId.slice(0, cut);
        if (source !== 'telegram' || r.processed || r.payload === null || r.boot_id === p[0]
          || r.attempts >= 1 || r.ageMin >= Number(p[2]) || r.ageMin * 60 <= Number(p[3])) continue;
        if (out.length >= Number(p[1])) break;
        r.boot_id = String(p[0]); r.attempts += 1;
        out.push({ update_key: rowId.slice(cut + 1), payload: r.payload });
      }
      return { rows: out };
    }
    if (q.startsWith('DELETE FROM chat_inbound_seen')) return { rows: [] };
    throw new Error(`неожиданный запрос к chat_inbound_seen: ${q}`);
  }

  return {
    rows,
    handle,
    get: (source: string, key: string) => rows.get(id(source, key)),
    /** Строка, оставленная другим запуском (тот упал, не закончив); по умолчанию ей 5 минут. */
    leftBy(boot: string, source: string, key: string, over: Partial<InboundRow> = {}) {
      rows.set(id(source, key), { hits: 1, boot_id: boot, processed: false, attempts: 0, payload: null, ageMin: 5, ...over });
    },
    fail(err: Error | null) { failing = err; },
    clear() { rows.clear(); failing = null; },
  };
}
