import type { Context, Next } from 'hono';
import type { Env, ContextVariables } from '../types.js';

const ALLOWED_ORIGINS_PROD = [
  'https://fakeag.com',
  'https://www.fakeag.com',
];

export async function corsMiddleware(
  c: Context<{ Bindings: Env; Variables: ContextVariables }>,
  next: Next
): Promise<Response | void> {
  const origin = c.req.header('Origin') ?? '';
  const isDev = c.env.ENVIRONMENT === 'development';

  const allowedOrigin =
    isDev
      ? origin || '*'
      : ALLOWED_ORIGINS_PROD.includes(origin)
      ? origin
      : ALLOWED_ORIGINS_PROD[0];

  // Handle preflight
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, X-API-Secret, X-Session-Token',
        'Access-Control-Max-Age': '86400',
        'Access-Control-Allow-Credentials': 'true',
      },
    });
  }

  await next();

  c.res.headers.set('Access-Control-Allow-Origin', allowedOrigin);
  c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
}
