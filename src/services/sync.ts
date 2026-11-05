import { recruitmentMessage } from '../components';
import { Repository } from '../database/repository';
import { Discord, DiscordError } from './discord';

interface Job { recruitment_id: string; attempts: number; first_attempt_at: number | null }

export class MessageSync {
  constructor(private repo: Repository, private discord: Discord) {}
  async run(id: string, now = Date.now()): Promise<void> {
    const lease = crypto.randomUUID();
    const job = await this.repo.db.prepare(`UPDATE message_jobs SET lease_owner=?,lease_expires_at=?
      WHERE recruitment_id=? AND blocked=0 AND next_attempt_at<=? AND lease_expires_at<=? RETURNING *`)
      .bind(lease, now + 30000, id, now, now).first<Job>();
    if (!job) return;
    try {
      // 실행당 최대 두 번 갱신하며 남은 변경은 Cron에 넘긴다.
      for (let pass = 0; pass < 2; pass++) {
        const current = await this.repo.recruitment(id);
        if (!current) return;
        if (!current.message_id) {
          if (current.status !== 'publishing') return;
          if (current.ends_at <= Date.now()) {
            await this.block(id, lease, 'publish_expired');
            return;
          }
          if (job.first_attempt_at !== null && now - job.first_attempt_at >= 120000) {
            // Discord nonce의 보장 기간을 넘어서는 재전송은 중복 알림을 만들 수 있다.
            await this.block(id, lease, 'publish_ambiguous');
            return;
          }
          const selected: string[] = JSON.parse(current.role_ids_json);
          if (selected.length) {
            const roles = await this.discord.roles(current.guild_id);
            if (selected.some(roleId => roleId === current.guild_id || !roles.some(role => role.id === roleId && !role.managed))) {
              await this.block(id, lease, 'role_unavailable');
              return;
            }
          }
          await this.repo.db.prepare('UPDATE message_jobs SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE recruitment_id=? AND lease_owner=?').bind(now, id, lease).run();
          const message = await this.discord.create(current.channel_id, current.id, recruitmentMessage(current, true));
          await this.repo.db.prepare(`UPDATE recruitments SET message_id=?,status='open' WHERE id=? AND message_id IS NULL
            AND EXISTS(SELECT 1 FROM message_jobs WHERE recruitment_id=? AND lease_owner=?)`).bind(message.id, id, id, lease).run();
          // 상태 변경으로 증가한 version까지 새 스냅샷으로 PATCH한다.
          continue;
        }
        await this.discord.edit(current.channel_id, current.message_id, recruitmentMessage(current));
        await this.repo.db.prepare(`UPDATE recruitments SET synced_version=MAX(synced_version,?),next_reconcile_at=? WHERE id=?
          AND EXISTS(SELECT 1 FROM message_jobs WHERE recruitment_id=? AND lease_owner=?)`).bind(current.version, Date.now() + 600000, id, id, lease).run();
        const result = await this.repo.db.prepare(`DELETE FROM message_jobs WHERE recruitment_id=? AND lease_owner=?
          AND EXISTS(SELECT 1 FROM recruitments WHERE id=? AND synced_version>=version)`).bind(id, lease, id).run();
        if (result.meta.changes) return;
      }
      await this.repo.db.prepare('UPDATE message_jobs SET lease_owner=NULL,lease_expires_at=0 WHERE recruitment_id=? AND lease_owner=?').bind(id, lease).run();
    } catch (error) {
      const code = error instanceof DiscordError ? `discord_${error.status}` : 'sync_internal';
      const permanent = error instanceof DiscordError && [400, 401, 403, 404].includes(error.status);
      if (permanent || job.attempts >= 7) { await this.block(id, lease, code); return; }
      const delay = Math.max(error instanceof DiscordError ? error.retryAfterMs : 0, Math.min(300000, 1000 * 2 ** job.attempts));
      await this.repo.db.prepare(`UPDATE message_jobs SET attempts=attempts+1,next_attempt_at=?,lease_owner=NULL,lease_expires_at=0,last_error_code=? WHERE recruitment_id=? AND lease_owner=?`)
        .bind(Date.now() + delay, code, id, lease).run();
      console.warn(JSON.stringify({ event: 'message_sync_retry', recruitmentId: id, code }));
    }
  }
  private async block(id: string, lease: string, code: string) {
    await this.repo.db.batch([
      this.repo.db.prepare('UPDATE message_jobs SET blocked=1,last_error_code=?,lease_owner=NULL,lease_expires_at=0 WHERE recruitment_id=? AND lease_owner=?').bind(code, id, lease),
      this.repo.db.prepare("UPDATE recruitments SET status='publish_failed' WHERE id=? AND message_id IS NULL AND EXISTS(SELECT 1 FROM message_jobs WHERE recruitment_id=? AND blocked=1)").bind(id, id),
    ]);
    console.warn(JSON.stringify({ event: 'message_sync_blocked', recruitmentId: id, code }));
  }
  async drain(now = Date.now()): Promise<void> {
    const jobs = await this.repo.db.prepare('SELECT recruitment_id FROM message_jobs WHERE blocked=0 AND next_attempt_at<=? AND lease_expires_at<=? LIMIT 5').bind(now, now).all<Job>();
    await Promise.all(jobs.results.map(job => this.run(job.recruitment_id, now)));
  }
}
