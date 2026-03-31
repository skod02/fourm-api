import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types.js';
import { generateApiSecret, hashToken, now } from '../lib/auth.js';

export interface UserOnboardingParams {
  userId: string;
  username: string;
  email: string;
}

export class UserOnboardingWorkflow extends WorkflowEntrypoint<Env, UserOnboardingParams> {
  async run(event: WorkflowEvent<UserOnboardingParams>, step: WorkflowStep): Promise<void> {
    const { userId, username } = event.payload;

    // Step 1: Generate and store API secret
    await step.do('generate-api-secret', { retries: { limit: 3, delay: '2 seconds' } }, async () => {
      const rawSecret = generateApiSecret();
      const secretHash = await hashToken(rawSecret);
      const nowTs = now();

      await this.env.DB.prepare(
        'UPDATE users SET api_secret_hash = ?, updated_at = ? WHERE id = ?'
      )
        .bind(secretHash, nowTs, userId)
        .run();

      // Store raw secret temporarily in KV for the user to retrieve once
      // Expires in 1 hour — user must copy it from settings
      await this.env.SESSIONS_KV.put(
        `onboarding_secret:${userId}`,
        rawSecret,
        { expirationTtl: 3600 }
      );

      return { secretGenerated: true };
    });

    // Step 2: Send welcome inbox message
    await step.do('send-welcome-message', { retries: { limit: 3, delay: '2 seconds' } }, async () => {
      const nowTs = now();
      const msgId = crypto.randomUUID();

      await this.env.DB.prepare(
        `INSERT INTO messages (id, from_id, to_id, content, created_at)
         VALUES (?, 'system', ?, ?, ?)`
      )
        .bind(
          msgId,
          userId,
          `👋 Welcome to the community, @${username}!

Your account is now active. Here's what you can do:
• Post and reply to threads in the forum
• Access your API secret key in Settings
• Apply for VIP membership for full marketplace access
• Use your API secret to integrate our licensing system into your tools

📌 Remember: This is a security research community. All posts must follow our responsible disclosure policy.`,
          nowTs
        )
        .run();

      return { welcomeSent: true };
    });

    // Step 3: Track signup in Analytics Engine
    await step.do('track-analytics', async () => {
      this.env.ANALYTICS.writeDataPoint({
        blobs: ['user_signup', userId, username, '', '', ''],
        doubles: [Math.floor(Date.now() / 1000), 1],
        indexes: ['user_signup'],
      });
      return { tracked: true };
    });
  }
}
