// ============================================================
// types.ts — Shared types & Env interface
// ============================================================

export interface Env {
  // D1 Database
  DB: D1Database;

  // KV Namespaces
  SESSIONS_KV: KVNamespace;     // Session token cache
  CACHE_KV: KVNamespace;        // Announcements, stats cache

  // R2 Bucket
  ATTACHMENTS: R2Bucket;

  // Queues
  WEBHOOK_QUEUE: Queue<WebhookMessage>;
  EMAIL_QUEUE: Queue<EmailMessage>;

  // Durable Objects
  ONLINE_TRACKER: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;

  // Workflows
  VIP_APPROVAL_WORKFLOW: Workflow;
  USER_ONBOARDING_WORKFLOW: Workflow;
  DMCA_TAKEDOWN_WORKFLOW: Workflow;
  DB_BACKUP_WORKFLOW: Workflow;

  // Analytics Engine
  ANALYTICS: AnalyticsEngineDataset;

  // Secrets / Env Vars
  TURNSTILE_SECRET_KEY: string;
  JWT_SECRET: string;
  ENVIRONMENT: string; // 'development' | 'production'
}

// ============================================================
// Database Models
// ============================================================

export type UserRole = 'guest' | 'user' | 'mod' | 'admin';
export type ThreadStatus = 'active' | 'removed' | 'locked';
export type ListingStatus = 'pending' | 'active' | 'removed';
export type KeyStatus = 'valid' | 'expired' | 'banned' | 'maxed';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';
export type VipRequestStatus = 'pending' | 'approved' | 'denied';
export type DmcaStatus = 'pending' | 'under_review' | 'upheld' | 'dismissed';

export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: UserRole;
  is_vip: number;
  is_banned: number;
  reputation: number;
  api_secret_hash: string | null;
  vip_key: string | null;
  username_changes: number;
  created_at: number;
  updated_at: number;
}

export interface Session {
  token_hash: string;
  user_id: string;
  ip: string;
  user_agent: string | null;
  expires_at: number;
  created_at: number;
}

export interface Thread {
  id: string;
  title: string;
  content: string;
  author_id: string;
  section: string;
  vip_only: number;
  is_announcement: number;
  status: ThreadStatus;
  view_count: number;
  reply_count: number;
  created_at: number;
  updated_at: number;
}

export interface Reply {
  id: string;
  thread_id: string;
  author_id: string;
  content: string;
  status: 'active' | 'removed';
  created_at: number;
  updated_at: number;
}

export interface App {
  id: string;
  owner_id: string;
  name: string;
  webhook_url: string | null;
  api_secret_hash: string;
  created_at: number;
  updated_at: number;
}

export interface LicenseKey {
  key: string;
  app_id: string;
  status: KeyStatus;
  max_devices: number;
  device_ids: string; // JSON
  usage_count: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_ip: string | null;
  created_at: number;
}

export interface Listing {
  id: string;
  title: string;
  description: string;
  seller_id: string;
  category: string;
  status: ListingStatus;
  vip_required: number;
  price: number | null;
  download_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  from_id: string;
  to_id: string;
  content: string;
  read_at: number | null;
  created_at: number;
}

export interface Report {
  id: string;
  reporter_id: string;
  target_type: 'thread' | 'reply' | 'listing' | 'user';
  target_id: string;
  reason: string;
  status: ReportStatus;
  resolved_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  author_id: string;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface VipRequest {
  id: string;
  user_id: string;
  status: VipRequestStatus;
  reason: string | null;
  workflow_instance_id: string | null;
  reviewed_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DmcaRequest {
  id: string;
  requester_name: string;
  requester_email: string;
  target_type: string;
  target_id: string;
  description: string;
  status: DmcaStatus;
  workflow_instance_id: string | null;
  resolved_by: string | null;
  created_at: number;
  updated_at: number;
}

// ============================================================
// Queue Payloads
// ============================================================

export interface WebhookMessage {
  url: string;
  event: string;
  payload: Record<string, unknown>;
  attempt?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  type: 'welcome' | 'password_reset' | 'vip_approved' | 'vip_denied' | 'dmca';
}

// ============================================================
// API Response Types
// ============================================================

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    cursor?: string;
  };
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ============================================================
// Context Variables (Hono)
// ============================================================

export interface ContextVariables {
  user: User | null;
  sessionToken: string | null;
  appId: string | null;
  requestId: string;
}
