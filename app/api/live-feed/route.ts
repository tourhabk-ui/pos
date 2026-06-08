import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface LiveBooking {
  id: string;
  tour_title: string;
  operator_name: string;
  created_at: string;
}

interface ActiveRoute {
  name: string;
  tourists_hour: number;
  tourists_today: number;
}

export interface LiveFeedData {
  bookings_today: number;
  confirmed_today: number;
  active_routes: ActiveRoute[];
  recent_bookings: LiveBooking[];
  updated_at: string;
}

export async function GET() {
  try {
    const [bookingsRes, routesRes, recentRes] = await Promise.all([
      pool.query<{ bookings_today: string; confirmed_today: string }>(`
        SELECT
          COUNT(*)::text AS bookings_today,
          COUNT(*) FILTER (WHERE booking_status = 'confirmed')::text AS confirmed_today
        FROM operator_bookings
        WHERE created_at > NOW() - '24 hours'::interval
      `),
      pool.query<ActiveRoute>(`
        SELECT
          p.name,
          r.tourists_hour,
          r.tourists_today
        FROM location_real_time_status r
        JOIN places p ON r.agent_route_id::text = p.ark_id::text
        WHERE r.tourists_hour > 0
        ORDER BY r.tourists_hour DESC
        LIMIT 5
      `),
      pool.query<LiveBooking>(`
        SELECT
          ob.id::text,
          ot.title AS tour_title,
          p.name AS operator_name,
          ob.created_at::text
        FROM operator_bookings ob
        JOIN operator_tours ot ON ob.operator_tour_id = ot.id
        JOIN partners p ON ot.operator_id = p.id
        WHERE ob.booking_status IN ('confirmed', 'new')
          AND ob.created_at > NOW() - '48 hours'::interval
        ORDER BY ob.created_at DESC
        LIMIT 10
      `),
    ]);

    const data: LiveFeedData = {
      bookings_today: parseInt(bookingsRes.rows[0]?.bookings_today ?? '0'),
      confirmed_today: parseInt(bookingsRes.rows[0]?.confirmed_today ?? '0'),
      active_routes: routesRes.rows,
      recent_bookings: recentRes.rows,
      updated_at: new Date().toISOString(),
    };

    return NextResponse.json({ ok: true, data }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
