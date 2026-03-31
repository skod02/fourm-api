import type { ApiError, ApiSuccess } from '../types.js';

/** Success response */
export function ok<T>(
  data: T,
  meta?: ApiSuccess<T>['meta'],
  status = 200
): Response {
  const body: ApiSuccess<T> = { success: true, data, ...(meta ? { meta } : {}) };
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Error response */
export function err(
  code: string,
  message: string,
  status = 400,
  details?: unknown
): Response {
  const body: ApiError = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Shorthand helpers
export const notFound = (msg = 'Not found') => err('NOT_FOUND', msg, 404);
export const unauthorized = (msg = 'Unauthorized') => err('UNAUTHORIZED', msg, 401);
export const forbidden = (msg = 'Forbidden') => err('FORBIDDEN', msg, 403);
export const badRequest = (msg: string, details?: unknown) =>
  err('BAD_REQUEST', msg, 400, details);
export const internalError = (msg = 'Internal server error') =>
  err('INTERNAL_ERROR', msg, 500);
export const rateLimit = (msg = 'Rate limit exceeded') =>
  err('RATE_LIMITED', msg, 429);
export const conflict = (msg: string) => err('CONFLICT', msg, 409);
export const created = <T>(data: T) => ok(data, undefined, 201);
