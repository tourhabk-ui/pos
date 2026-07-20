/**
 * POST /api/admin/import/road-graph
 *
 * Приём дорожного графа Камчатки, построенного на раннере GitHub Actions
 * (scripts/build-road-graph.js): с Timeweb OSM/Overpass недоступен, поэтому
 * раннер качает и строит, а прод только принимает чанки в БД (миграция 760).
 *
 * Auth: CRON_SECRET (Bearer) — вызывается workflow, не человеком.
 *
 * Протокол (последовательные POST):
 *   {mode:'reset', note?}            → чистит таблицы, открывает import-сессию
 *   {mode:'nodes', rows:[[id,lat,lng],...]}                — чанк узлов
 *   {mode:'edges', rows:[[from,to,len,hwy,surf,name,geom],...]} — чанк рёбер
 *   {mode:'finish', import_id}       → закрывает сессию, пишет счётчики
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const NodeRow = z.tuple([z.number().int(), z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const EdgeRow = z.tuple([
  z.number().int(),                     // from_node
  z.number().int(),                     // to_node
  z.number().positive(),                // length_m
  z.string().min(1).max(32),            // highway
  z.string().max(32).nullable(),        // surface
  z.string().max(500).nullable(),       // name
  z.array(z.tuple([z.number(), z.number()])).min(2), // geometry [[lat,lng],...]
]);

const BodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('reset'), note: z.string().max(500).optional() }),
  z.object({ mode: z.literal('nodes'), rows: z.array(NodeRow).min(1).max(10_000) }),
  z.object({ mode: z.literal('edges'), rows: z.array(EdgeRow).min(1).max(3_000) }),
  z.object({ mode: z.literal('finish'), import_id: z.number().int() }),
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(req), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof z.ZodError ? e.errors[0]?.message : 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  if (body.mode === 'reset') {
    await query('TRUNCATE road_graph_edges');
    await query('TRUNCATE road_graph_nodes');
    const r = await query<{ id: number }>(
      `INSERT INTO road_graph_imports (source, note) VALUES ('overpass', $1) RETURNING id`,
      [body.note ?? null],
    );
    return NextResponse.json({ ok: true, import_id: r.rows[0].id });
  }

  if (body.mode === 'nodes') {
    const values: unknown[] = [];
    const tuples = body.rows.map((row, i) => {
      values.push(row[0], row[1], row[2]);
      const o = i * 3;
      return `($${o + 1},$${o + 2},$${o + 3})`;
    });
    await query(
      `INSERT INTO road_graph_nodes (id, lat, lng) VALUES ${tuples.join(',')}
       ON CONFLICT (id) DO NOTHING`,
      values,
    );
    return NextResponse.json({ ok: true, inserted: body.rows.length });
  }

  if (body.mode === 'edges') {
    const values: unknown[] = [];
    const tuples = body.rows.map((row, i) => {
      values.push(row[0], row[1], row[2], row[3], row[4], row[5], JSON.stringify(row[6]));
      const o = i * 7;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
    });
    await query(
      `INSERT INTO road_graph_edges (from_node, to_node, length_m, highway, surface, name, geometry)
       VALUES ${tuples.join(',')}`,
      values,
    );
    return NextResponse.json({ ok: true, inserted: body.rows.length });
  }

  // finish
  const counts = await query<{ nodes: string; edges: string }>(
    `SELECT (SELECT COUNT(*) FROM road_graph_nodes)::text AS nodes,
            (SELECT COUNT(*) FROM road_graph_edges)::text AS edges`,
  );
  const nodesCount = parseInt(counts.rows[0].nodes, 10);
  const edgesCount = parseInt(counts.rows[0].edges, 10);
  await query(
    `UPDATE road_graph_imports
     SET finished_at = now(), nodes_count = $2, edges_count = $3
     WHERE id = $1`,
    [body.import_id, nodesCount, edgesCount],
  );
  return NextResponse.json({ ok: true, nodes: nodesCount, edges: edgesCount });
}
