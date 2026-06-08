/**
 * API: List/Create Tickets
 * GET /api/support/tickets - list tickets with filtering
 * POST /api/support/tickets - create new ticket
 */

import { NextRequest, NextResponse } from 'next/server'
import { ticketService } from '@/lib/services'
import { CreateTicketSchema, validateInput, CreateTicketInput } from '@/lib/validation/support-schemas'
import { requireAuth } from '@/lib/auth/middleware'
import type { Ticket, TicketFilter } from '@/pillars/support-pillar/services/ticket.service'

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request)
  if (auth instanceof NextResponse) return auth

  try {
    const searchParams = request.nextUrl.searchParams
    const isPrivileged = auth.role === 'admin' || auth.role === 'agent'

    const filter: TicketFilter = {
      status: searchParams.get('status') || undefined,
      priority: searchParams.get('priority') || undefined,
      category: searchParams.get('category') || undefined,
      customerId: isPrivileged
        ? (searchParams.get('customerId') || undefined)
        : auth.userId,
      agentId: searchParams.get('agentId') || undefined,
      search: searchParams.get('search') || undefined,
      page: parseInt(searchParams.get('page') || '1'),
      limit: parseInt(searchParams.get('limit') || '20'),
      sortBy: searchParams.get('sortBy') || 'createdAt',
      sortOrder: searchParams.get('sortOrder') || 'DESC',
    }

    const result = await ticketService.listTickets(filter)

    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request)
  if (auth instanceof NextResponse) return auth

  try {
    const data = await request.json()
    const isPrivileged = auth.role === 'admin' || auth.role === 'agent'

    let ticketData: Record<string, unknown>
    if (isPrivileged && data.customerId !== undefined) {
      const validation = validateInput<CreateTicketInput>(CreateTicketSchema, data)
      if (!validation.success) {
        return NextResponse.json(
          { success: false, errors: validation.errors },
          { status: 400 }
        )
      }
      ticketData = validation.data as Record<string, unknown>
    } else {
      const SelfCreateSchema = CreateTicketSchema.omit({ customerId: true })
      const validation = validateInput<Omit<CreateTicketInput, 'customerId'>>(SelfCreateSchema, data)
      if (!validation.success) {
        return NextResponse.json(
          { success: false, errors: validation.errors },
          { status: 400 }
        )
      }
      ticketData = { ...validation.data, customerId: auth.userId }
    }

    const ticket = await ticketService.createTicket(ticketData as Partial<Ticket>)

    return NextResponse.json({
      success: true,
      data: ticket,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 400 }
    )
  }
}
