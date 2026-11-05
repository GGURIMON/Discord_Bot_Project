import { ensureThread,threadMembers } from './threads';
import { clockTime } from '../domain';
import { Discord, DiscordError } from './discord';

const minute = 60_000;
const reminderLead = 10 * minute;
// A Discord message allows 2000 characters and at most 100 explicitly allowed users.
const pageSize = 75;
type Job = {
  recruitment_id: string; due_at: number; thread_id: string | null; attempts: number;
  recipients: string | null; position: number; first_send_at: number | null;
};
type Source = {guild_id:string; channel_id:string; message_id:string; games_json:string; starts_at:number};


export class StartReminders {
  constructor(private db:D1Database, private discord:Discord, private clock:()=>number = Date.now) {}

  async drain() {
    const now = this.clock();
    const jobs = await this.db.prepare(`SELECT j.recruitment_id FROM start_reminders j JOIN recruitments r ON r.id=j.recruitment_id
      WHERE j.blocked=0 AND j.sent_at IS NULL AND j.next_at BETWEEN ? AND ? AND j.due_at>?
      AND j.lease_until<=? AND r.status='open' AND r.starts_at=j.due_at+600000 AND r.ends_at>?
      AND r.message_id IS NOT NULL ORDER BY j.next_at,j.recruitment_id LIMIT 2`)
      .bind(now-reminderLead,now,now-reminderLead,now,now).all<{recruitment_id:string}>();
    for (const candidate of jobs.results) {
      try { await this.run(candidate.recruitment_id); }
      catch { console.warn('reminder_db_error',candidate.recruitment_id); }
    }
  }

  private async run(id:string) {
    const now = this.clock();
    const claim = crypto.randomUUID();
    const job = await this.db.prepare(`UPDATE start_reminders SET claim=?,lease_until=?
      WHERE recruitment_id=? AND sent_at IS NULL AND blocked=0 AND next_at<=? AND lease_until<=?
      AND due_at>? AND due_at<=? RETURNING *`)
      .bind(claim,now+45_000,id,now,now,now-reminderLead,now).first<Job>();
    if (!job) return;
    const source = () => this.db.prepare(`SELECT r.guild_id,r.channel_id,r.message_id,r.games_json,r.starts_at
      FROM recruitments r JOIN start_reminders j ON j.recruitment_id=r.id WHERE r.id=? AND j.claim=?
      AND r.status='open' AND r.message_id IS NOT NULL AND r.starts_at=j.due_at+600000
      AND r.starts_at>? AND r.ends_at>? AND j.lease_until>?`).bind(id,claim,this.clock(),this.clock(),this.clock()).first<Source>();
    try {
      const r = await source();
      if (!r) return;
      const game = (JSON.parse(r.games_json) as {name:string}[]).map(g=>g.name).join(', ');
      if (!job.thread_id) {
        const thread = await ensureThread(this.discord,r);
        const saved = await this.db.prepare('UPDATE start_reminders SET thread_id=? WHERE recruitment_id=? AND claim=?')
          .bind(thread.id,id,claim).run();
        if (!saved.meta.changes) return;
        job.thread_id=thread.id;
      }
      if (!job.recipients) {
        const confirmed = await this.db.prepare('SELECT user_id FROM participants WHERE recruitment_id=? ORDER BY joined_at,user_id').bind(id).all<{user_id:string}>();
        const members = await threadMembers(this.discord,job.thread_id,confirmed.results.map(p=>p.user_id));
        const snapshot = await this.db.prepare(`UPDATE start_reminders SET recipients=(SELECT json_group_array(user_id)
          FROM (SELECT user_id FROM participants WHERE recruitment_id=? AND user_id IN (SELECT value FROM json_each(?)) ORDER BY joined_at,user_id))
          WHERE recruitment_id=? AND claim=? RETURNING recipients`).bind(id,JSON.stringify([...members]),id,claim).first<string>('recipients');
        if (!snapshot) return;
        job.recipients=snapshot;
      }
      const users:string[] = JSON.parse(job.recipients);
      for (let page=0; page<4; page++) {
        if (!await source()) return;
        const start = job.position;
        const chunk = users.slice(start,start+pageSize);
        // Never replay an ambiguous send beyond Discord's recent nonce deduplication window.
        if (job.first_send_at!==null && this.clock()-job.first_send_at>=120_000) throw new Error('ambiguous_send');
        const marked = await this.db.prepare(`UPDATE start_reminders SET first_send_at=coalesce(first_send_at,?),lease_until=?
          WHERE recruitment_id=? AND claim=?`).bind(this.clock(),this.clock()+45_000,id,claim).run();
        if (!marked.meta.changes) return;
        const remainingMs = r.starts_at-this.clock();
        if (remainingMs<=0) return;
        const remaining = remainingMs<minute ? '시작까지 1분 미만입니다' : `시작 ${Math.ceil(remainingMs/minute)}분 전입니다`;
        const title = start===0 ? `🎮 ${game.slice(0,110)} — ${remaining}!\n게임 시작 예정: ${clockTime(r.starts_at)}\n\n` : '';
        const mentions = chunk.map(user=>`<@${user}>`).join(' ');
        await this.discord.create(job.thread_id,`${id}-${start}`,{
          content:`${title}참가자 알림\n${mentions}\n게임 시작 준비를 해주세요!`,components:[],
          allowed_mentions:{parse:[],roles:[],users:chunk,replied_user:false}
        });
        job.position+=chunk.length;
        job.first_send_at=null;
        const done=job.position>=users.length;
        const saved=await this.db.prepare(`UPDATE start_reminders SET position=?,first_send_at=NULL,attempts=0,last_error=NULL,
          sent_at=?,recipients=CASE WHEN ? THEN NULL ELSE recipients END WHERE recruitment_id=? AND claim=?`)
          .bind(job.position,done?this.clock():null,done?1:0,id,claim).run();
        if (done || !saved.meta.changes) return;
      }
    } catch(error) {
      const status=error instanceof DiscordError ? error.status : 0;
      const ambiguous=error instanceof Error && error.message==='ambiguous_send';
      const blocked=ambiguous || [400,401,403,404].includes(status);
      const delay=Math.max(minute, error instanceof DiscordError ? error.retryAfterMs : 0);
      // A rate-limit response confirms that Discord did not accept this send.
      const code=ambiguous?'ambiguous_send':`discord_${status}`;
      await this.db.prepare(`UPDATE start_reminders SET attempts=attempts+1,blocked=?,last_error=?,next_at=?,
        first_send_at=CASE WHEN ? THEN NULL ELSE first_send_at END WHERE recruitment_id=? AND claim=?`)
        .bind(blocked?1:0,code,this.clock()+delay,status===429 && job.first_send_at===null ? 1 : 0,id,claim).run();
      console.warn('start_reminder_failed',id,code);
    } finally {
      await this.db.prepare('UPDATE start_reminders SET claim=NULL,lease_until=0 WHERE recruitment_id=? AND claim=?').bind(id,claim).run();
    }
  }
}
