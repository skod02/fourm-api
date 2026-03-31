import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types.js';

interface DbBackupParams {
  triggeredAt: number;
}

export class DbBackupWorkflow extends WorkflowEntrypoint<Env, DbBackupParams> {
  async run(event: WorkflowEvent<DbBackupParams>, step: WorkflowStep): Promise<void> {
    const { triggeredAt } = event.payload;
    const backupDate = new Date(triggeredAt * 1000).toISOString().split('T')[0];
    const r2Key = `backups/d1/${backupDate}/forum_db.sqlite3`;

    // Step 1: Export D1 to R2 using the D1 Export API
    await step.do(
      'export-d1',
      { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
      async () => {
        // D1 export via REST API requires account ID + DB ID.
        // In production, these come from environment variables.
        // Here we demonstrate the pattern using a direct SQL dump approach.

        // Query all table names
        const tables = await this.env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all<{ name: string }>();

        const dump: Record<string, unknown[]> = {};
        for (const table of tables.results) {
          const rows = await this.env.DB.prepare(
            `SELECT * FROM ${table.name}`
          ).all();
          dump[table.name] = rows.results;
        }

        const dumpJson = JSON.stringify({
          exported_at: new Date().toISOString(),
          tables: dump,
        });

        await this.env.ATTACHMENTS.put(
          r2Key,
          dumpJson,
          {
            httpMetadata: {
              contentType: 'application/json',
            },
            customMetadata: {
              backup_date: backupDate,
              exported_at: new Date().toISOString(),
            },
          }
        );

        return { r2Key, size: dumpJson.length };
      }
    );

    // Step 2: Clean up backups older than 30 days
    await step.do('cleanup-old-backups', { retries: { limit: 2, delay: '10 seconds' } }, async () => {
      const cutoffDate = new Date(triggeredAt * 1000);
      cutoffDate.setDate(cutoffDate.getDate() - 30);
      const cutoffPrefix = `backups/d1/${cutoffDate.toISOString().split('T')[0]}`;

      const listed = await this.env.ATTACHMENTS.list({ prefix: 'backups/d1/' });
      let deleted = 0;

      for (const obj of listed.objects) {
        if (obj.key < cutoffPrefix) {
          await this.env.ATTACHMENTS.delete(obj.key);
          deleted++;
        }
      }

      return { deletedOld: deleted };
    });
  }
}
