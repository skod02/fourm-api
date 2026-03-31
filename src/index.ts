import { Hono } from 'hono';
import type { Env, ContextVariables } from './types.js';

// Middleware
import { corsMiddleware } from './middleware/cors.js';
import { rateLimitMiddleware, AUTH_LIMIT, API_LIMIT, EXT_LIMIT } from './middleware/ratelimit.js';

// Routes
import authRoutes from './routes/auth.js';
import threadRoutes from './routes/threads.js';
import marketplaceRoutes from './routes/marketplace.js';
import messageRoutes from './routes/messages.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import extRoutes from './routes/ext.js';

// Durable Objects (re-exported for Wrangler binding)
export { RateLimiter } from './durable-objects/rate-limiter.js';
export { OnlineTracker } from './durable-objects/online-tracker.js';

// Workflows (re-exported for Wrangler binding)
export { VipApprovalWorkflow } from './workflows/vip-approval.js';
export { UserOnboardingWorkflow } from './workflows/user-onboarding.js';
export { DmcaTakedownWorkflow } from './workflows/dmca-takedown.js';
export { DbBackupWorkflow } from './workflows/db-backup.js';

// ── App setup ────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env; Variables: ContextVariables }>();

// ── Global Middleware ────────────────────────────────────────
app.use('*', corsMiddleware);

// Inject request ID for correlation
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.set('user', null);
  c.set('sessionToken', null);
  c.set('appId', null);
  return next();
});

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '1.0.0',
    ts: Math.floor(Date.now() / 1000),
    requestId: c.get('requestId'),
  });
});

// ── Auth Routes (strict rate limit on register/login) ────────
app.use('/api/auth/register', rateLimitMiddleware(AUTH_LIMIT));
app.use('/api/auth/login', rateLimitMiddleware(AUTH_LIMIT));
app.use('/api/auth/*', rateLimitMiddleware(API_LIMIT));
app.route('/api/auth', authRoutes);

// ── Thread Routes ────────────────────────────────────────────
app.use('/api/threads/*', rateLimitMiddleware(API_LIMIT));
app.route('/api/threads', threadRoutes);

// ── Marketplace Routes ───────────────────────────────────────
app.use('/api/listings/*', rateLimitMiddleware(API_LIMIT));
app.route('/api/listings', marketplaceRoutes);

// ── Message Routes ───────────────────────────────────────────
app.use('/api/messages/*', rateLimitMiddleware(API_LIMIT));
app.route('/api/messages', messageRoutes);

// ── User Routes ──────────────────────────────────────────────
app.use('/api/users/*', rateLimitMiddleware(API_LIMIT));
app.route('/api/users', userRoutes);

// ── Report & DMCA Routes ─────────────────────────────────────
app.use('/api/reports/*', rateLimitMiddleware(API_LIMIT));
app.use('/api/dmca/*', rateLimitMiddleware(API_LIMIT));
app.route('/api', reportRoutes);

// ── Admin Routes ─────────────────────────────────────────────
app.use('/api/admin/*', rateLimitMiddleware(API_LIMIT));
app.route('/api/admin', adminRoutes);

// ── External Licensing API (higher throughput) ────────────────
app.use('/api/ext/*', rateLimitMiddleware(EXT_LIMIT));
app.route('/api/ext', extRoutes);

// ── 404 fallback ─────────────────────────────────────────────
app.notFound((c) => {
  return c.json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
  }, 404);
});

// ── Global Error Handler ─────────────────────────────────────
app.onError((err, c) => {
  console.error('[worker] unhandled error:', {
    requestId: c.get('requestId'),
    path: c.req.path,
    method: c.req.method,
    error: err.message,
    stack: err.stack,
  });

  return c.json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: c.get('requestId'),
    },
  }, 500);
});

// ── Queue Consumer ────────────────────────────────────────────
// Handles webhook delivery from WEBHOOK_QUEUE
async function handleQueue(
  batch: MessageBatch,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (batch.queue === 'webhook-queue') {
        const { deliverWebhook } = await import('./lib/webhook.js');
        const payload = message.body as import('./types.js').WebhookMessage;
        const result = await deliverWebhook(payload);

        if (result.ok) {
          message.ack();
        } else if (result.status >= 400 && result.status < 500) {
          // Client errors — don't retry (e.g., 404 webhook URL)
          console.warn('[queue] webhook 4xx, dropping:', payload.url, result.status);
          message.ack();
        } else {
          // 5xx — retry
          message.retry();
        }
      } else if (batch.queue === 'email-queue') {
        const payload = message.body as import('./types.js').EmailMessage;
        // Email delivery is stubbed — integrate with Mailchannels/Resend/SendGrid
        console.log('[queue] email delivery stub:', payload.type, payload.to);
        message.ack();
      } else {
        message.ack();
      }
    } catch (e) {
      console.error('[queue] consumer error:', e);
      message.retry();
    }
  }
}

// ── Scheduled (Cron) Handler ──────────────────────────────────
async function handleScheduled(
  event: ScheduledController,
  env: Env
): Promise<void> {
  console.log('[cron] triggered:', event.cron);

  // Daily DB backup at 2am UTC
  if (event.cron === '0 2 * * *') {
    try {
      await env.DB_BACKUP_WORKFLOW.create({
        params: { triggeredAt: Math.floor(Date.now() / 1000) },
      });
      console.log('[cron] DB backup workflow triggered');
    } catch (e) {
      console.error('[cron] DB backup trigger failed:', e);
    }
  }
}

// ── Default Export (Worker) ───────────────────────────────────
export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
