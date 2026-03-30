// lib/api.js
// Shared API utilities — response builder, error handler, prisma singleton

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

// ─── PRISMA SINGLETON (prevents connection pool exhaustion in dev) ─────────────

const globalForPrisma = globalThis;
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// ─── RESPONSE BUILDERS ────────────────────────────────────────────────────────

export function ok(data, status = 200) {
  return NextResponse.json({ success: true, ...data }, { status });
}

export function created(data) {
  return ok(data, 201);
}

export function err(message, status = 400, details = null) {
  return NextResponse.json({
    success: false,
    error: message,
    ...(details ? { details } : {}),
  }, { status });
}

export const Errors = {
  unauthorized: () => err('Unauthorized', 401),
  forbidden: () => err('Forbidden', 403),
  notFound: (resource = 'Resource') => err(`${resource} not found`, 404),
  conflict: (msg) => err(msg, 409),
  validation: (details) => err('Validation failed', 400, details),
  internal: (msg = 'Internal server error') => err(msg, 500),
  tooManyRequests: (limit, plan) => err(
    `Daily limit reached (${limit} for ${plan} plan)`,
    429
  ),
};

// ─── PLAN LIMITS ─────────────────────────────────────────────────────────────

export const PLAN_LIMITS = {
  FREE:  { slipsPerDay: 3,   predictionsPerDay: 5,   uploadsPerDay: 2   },
  PRO:   { slipsPerDay: 25,  predictionsPerDay: 50,  uploadsPerDay: 20  },
  ELITE: { slipsPerDay: 200, predictionsPerDay: 500, uploadsPerDay: 100 },
};

// ─── GET USER FROM CLERK ID ────────────────────────────────────────────────────

export async function getUserFromClerkId(clerkId) {
  return prisma.user.findUnique({ where: { clerkId } });
}

// ─── CHECK DAILY LIMIT ────────────────────────────────────────────────────────

export async function checkDailyLimit(userId, plan, resource) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
  const limit = limits[`${resource}PerDay`];

  let count;
  if (resource === 'slips') {
    count = await prisma.betSlip.count({ where: { userId, createdAt: { gte: today } } });
  } else if (resource === 'predictions') {
    count = await prisma.prediction.count({ where: { userId, createdAt: { gte: today } } });
  } else {
    count = 0;
  }

  return { allowed: count < limit, count, limit, remaining: Math.max(0, limit - count) };
}

// ─── PAGINATION HELPER ────────────────────────────────────────────────────────

export function getPagination(searchParams, defaultLimit = 10, maxLimit = 100) {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(maxLimit, Math.max(1, parseInt(searchParams.get('limit') || String(defaultLimit))));
  return { page, limit, skip: (page - 1) * limit };
}

export function paginatedResponse(data, total, page, limit) {
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}

// ─── ASYNC HANDLER WRAPPER ────────────────────────────────────────────────────
// Wraps route handlers with automatic error catching

export function withErrorHandler(handler) {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      console.error('Unhandled route error:', error);

      if (error.code === 'P2025') {
        return Errors.notFound();
      }
      if (error.code === 'P2002') {
        return Errors.conflict('Resource already exists');
      }
      if (error.name === 'ZodError') {
        return Errors.validation(error.errors);
      }

      return Errors.internal(
        process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      );
    }
  };
}
