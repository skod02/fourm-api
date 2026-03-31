// ============================================================
// workflows/dmca-takedown.ts
// DMCA Takedown Workflow
// Suspends content, waits for admin review, applies or restores.
// ============================================================

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types.js';
import { now } from '../lib/auth.js';

export interface DmcaTakedownParams {
  dmcaId: string;
  targetType: 'thread' | 'listing';
  targetId: string;
  requesterEmail: string;
  requesterName: string;
}

export class DmcaTakedownWorkflow extends WorkflowEntrypoint<Env, DmcaTakedownParams> {
  async run(event: WorkflowEvent<DmcaTakedownParams>, step: WorkflowStep): Promise<void> {
    const { dmcaId, targetType, targetId } = event.payload;

    // Step 1: Flag content as pending DMCA review
    await step.do('flag-content', { retries: { limit: 3, delay: '5 seconds' } }, async () => {
      const nowTs = now();

      if (targetType === 'thread') {
        await this.env.DB.prepare(
          'UPDATE threads SET status = ?, updated_at = ? WHERE id = ?'
        )
          .bind('locked', nowTs, targetId)
          .run();
      } else if (targetType === 'listing') {
        await this.env.DB.prepare(
          'UPDATE listings SET status = ?, updated_at = ? WHERE id = ?'
        )
          .bind('removed', nowTs, targetId)
          .run();
      }

      return { flagged: true };
    });

    // Step 2: Notify admins
    await step.do('notify-admins', { retries: { limit: 3, delay: '5 seconds' } }, async () => {
      const nowTs = now();
      const msgId = crypto.randomUUID();

      await this.env.DB.prepare(
        `INSERT INTO messages (id, from_id, to_id, content, created_at)
         SELECT ?, 'system', id, ?, ?
         FROM users WHERE role = 'admin'`
      )
        .bind(
          msgId,
          `⚠️ DMCA Request #${dmcaId}: Content "${targetType}/${targetId}" has been flagged and locked pending review.`,
          nowTs
        )
        .run();

      return { notified: true };
    });

    // Step 3: Wait for admin review (48 hours)
    await step.sleep('await-admin-review', '48 hours');

    // Step 4: Check decision
    const decision = await step.do('check-decision', async () => {
      const dmca = await this.env.DB.prepare(
        'SELECT status FROM dmca_requests WHERE id = ?'
      )
        .bind(dmcaId)
        .first<{ status: string }>();

      return { status: dmca?.status ?? 'pending' };
    });

    // Step 5: Apply final decision
    await step.do('apply-decision', async () => {
      const nowTs = now();

      if (decision.status === 'upheld') {
        // Keep content removed/locked
        await this.env.DB.prepare(
          'UPDATE dmca_requests SET status = ?, updated_at = ? WHERE id = ?'
        )
          .bind('upheld', nowTs, dmcaId)
          .run();
      } else if (decision.status === 'dismissed' || decision.status === 'pending') {
        // Restore content if dismissed or timed out without decision
        if (targetType === 'thread') {
          await this.env.DB.prepare(
            'UPDATE threads SET status = ?, updated_at = ? WHERE id = ?'
          )
            .bind('active', nowTs, targetId)
            .run();
        } else if (targetType === 'listing') {
          await this.env.DB.prepare(
            'UPDATE listings SET status = ?, updated_at = ? WHERE id = ?'
          )
            .bind('active', nowTs, targetId)
            .run();
        }

        // Update DMCA status if it was still pending
        if (decision.status === 'pending') {
          await this.env.DB.prepare(
            'UPDATE dmca_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
          )
            .bind('dismissed', nowTs, dmcaId, 'pending')
            .run();
        }
      }

      return { applied: true };
    });
  }
}
