// middleware.ts
// Global Next.js middleware — auth guard, rate limiting headers, plan enforcement

import { authMiddleware, redirectToSignIn } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// ─── PLAN RATE LIMITS (per 15 minutes) ───────────────────────────────────────
const PLAN_LIMITS = {
  FREE:  { predict: 5,  slips: 3,  upload: 2  },
  PRO:   { predict: 50, slips: 25, upload: 20 },
  ELITE: { predict: 500, slips: 200, upload: 100 },
} as const;

// ─── ROUTE CONFIGS ────────────────────────────────────────────────────────────
const PUBLIC_ROUTES = [
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
  '/api/webhooks/(.*)',
];

const PROTECTED_API_ROUTES = [
  '/api/slips',
  '/api/predict',
  '/api/results',
  '/api/formula',
  '/api/upload',
];

export default authMiddleware({
  publicRoutes: PUBLIC_ROUTES,

  afterAuth(auth, req) {
    const { pathname } = req.nextUrl;

    // ── Block unauthenticated access to protected routes ──────────────────
    if (!auth.userId && PROTECTED_API_ROUTES.some(r => pathname.startsWith(r))) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401, headers: corsHeaders() }
        );
      }
      return redirectToSignIn({ returnBackUrl: req.url });
    }

    // ── Add security headers ──────────────────────────────────────────────
    const response = NextResponse.next();

    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-XSS-Protection', '1; mode=block');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()'
    );

    // ── CORS for API routes ───────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      const origin = req.headers.get('origin');
      const allowedOrigins = [
        process.env.NEXT_PUBLIC_APP_URL,
        'http://localhost:3000',
        'http://localhost:3001',
      ].filter(Boolean);

      if (origin && allowedOrigins.includes(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Credentials', 'true');
        response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
    }

    return response;
  },
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.NEXT_PUBLIC_APP_URL || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};
