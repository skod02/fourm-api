import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types.js';
import { now } from '../lib/auth.js';

export interface VipApprovalParams {
  requestId: string;
  userId: string;
  username: string;
  reason?: string;
}

export class VipApprovalWorkflow extends WorkflowEntrypoint<Env, VipApprovalParams> {
  async run(event: WorkflowEvent<VipApprovalParams>, step: WorkflowStep): Promise<void> {
    const { requestId, userId, username } = event.payload;

    // Step 1: Notify admins via a message in the system inbox
    await step.do('notify-admins', { retries: { limit: 3, delay: '5 seconds' } }, async () => {
      const nowTs = now();
      const msgId = crypto.randomUUID();

      // Write a system notification to all admins
      await this.env.DB.prepare(
        `INSERT INTO messages (id, from_id, to_id, content, created_at)
         SELECT ?, 'system', id, ?, ?
         FROM users WHERE role = 'admin'`
      )
        .bind(
          msgId,
          `⚡ VIP Request #${requestId}: User @${username} has submitted a VIP membership request. Review in admin panel.`,
          nowTs
        )
        .run();

      return { notified: true };
    });

    // Step 2: Wait up to 72 hours for admin review
    await step.sleep('await-admin-review', '72 hours');

    // Step 3: Check the decision
    const decision = await step.do('check-decision', async () => {
      const request = await this.env.DB.prepare(
        'SELECT status, reviewed_by FROM vip_requests WHERE id = ?'
      )
        .bind(requestId)
        .first<{ status: string; reviewed_by: string | null }>();

      return {
        status: request?.status ?? 'pending',
        reviewedBy: request?.reviewed_by ?? null,
      };
    });

    // Step 4: Apply decision and notify user
    await step.do('apply-and-notify', async () => {
      const nowTs = now();
      const msgId = crypto.randomUUID();

      if (decision.status === 'approved') {
        // Grant VIP status
        const vipKey = `VIP-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
        await this.env.DB.batch([
          this.env.DB.prepare(
            'UPDATE users SET is_vip = 1, vip_key = ?, updated_at = ? WHERE id = ?'
          ).bind(vipKey, nowTs, userId),
          this.env.DB.prepare(
            `INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES (?, 'system', ?, ?, ?)`
          ).bind(
            msgId,
            userId,
            `✅ Your VIP request has been approved! Your VIP key: ${vipKey}. Welcome to VIP membership.`,
            nowTs
          ),
        ]);
      } else {
        // Denied or timed out — mark as denied
        await this.env.DB.batch([
          this.env.DB.prepare(
            'UPDATE vip_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
          ).bind('denied', nowTs, requestId, 'pending'),
          this.env.DB.prepare(
            `INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES (?, 'system', ?, ?, ?)`
          ).bind(
            msgId,
            userId,
            `❌ Your VIP request has been reviewed. Unfortunately, your request was not approved at this time.`,
            nowTs
          ),
        ]);
      }

      return { applied: true };
    });
  }
}
