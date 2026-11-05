import { Discord, DiscordError } from './discord';

type Source = {guild_id:string;channel_id:string;message_id:string;games_json:string};
type Thread = {id:string;type:number;guild_id:string;parent_id:string};
export async function ensureThread(discord:Discord,r:Source) {
  const game = (JSON.parse(r.games_json) as {name:string}[]).map(g=>g.name).join(', ');
  // A message-started thread shares its starter message ID, including after a lost create response.
  let thread: Thread;
  try { thread = await discord.request<Thread>('GET',`/channels/${r.message_id}`); }
  catch (error) {
    if (!(error instanceof DiscordError) || error.status!==404) throw error;
    const parent = await discord.request<{type:number;guild_id:string}>('GET',`/channels/${r.channel_id}`);
    if (parent.type!==0 || parent.guild_id!==r.guild_id) throw new DiscordError(400);
    thread = await discord.request<Thread>('POST',`/channels/${r.channel_id}/messages/${r.message_id}/threads`,
      {name:Array.from(`[시작 알림] ${game}`).slice(0,100).join('')});
  }
  if (thread.id!==r.message_id || thread.parent_id!==r.channel_id || thread.guild_id!==r.guild_id || thread.type!==11) throw new DiscordError(400);
  return thread;
}

export async function threadMembers(discord:Discord,threadId:string,candidates:string[]) {
  const wanted=new Set(candidates), found=new Set<string>();
  if (wanted.size<=10) {
    for (const user of wanted) {
      try {
        const member=await discord.request<{user_id:string}>('GET',`/channels/${threadId}/thread-members/${user}`);
        if (member.user_id===user) found.add(user);
      } catch(error) {
        if (!(error instanceof DiscordError) || error.status!==404) throw error;
      }
    }
    return found;
  }
  let after='0';
  while (found.size<wanted.size) {
    const page=await discord.request<{user_id:string}[]>('GET',`/channels/${threadId}/thread-members?with_member=true&limit=100&after=${after}`);
    for (const member of page) if (wanted.has(member.user_id)) found.add(member.user_id);
    if (page.length<100) break;
    const last=page.at(-1)!.user_id;
    if (!last || BigInt(last)<=BigInt(after)) throw new Error('Invalid thread member cursor');
    after=last;
  }
  return found;
}

// Queue entries exist only for new confirmed memberships. Leaving a thread manually is respected.
export async function syncThreadJoins(db:D1Database,discord:Discord,recruitmentId?:string) {
  const now=Date.now();
  const jobs=await db.prepare(`SELECT j.participant_id,j.attempts,p.user_id,r.guild_id,r.channel_id,r.message_id,r.games_json
    FROM thread_join_jobs j JOIN participants p ON p.id=j.participant_id JOIN recruitments r ON r.id=p.recruitment_id
    WHERE j.next_at<=? AND r.message_id IS NOT NULL AND r.status='open' AND r.ends_at>?
    ${recruitmentId ? 'AND r.id=?' : ''} ORDER BY j.next_at LIMIT 3`)
    .bind(now,now,...(recruitmentId?[recruitmentId]:[])).all<Source & {participant_id:string;attempts:number;user_id:string}>();
  for (const job of jobs.results) {
    const claimed=await db.prepare('UPDATE thread_join_jobs SET next_at=? WHERE participant_id=? AND next_at<=?')
      .bind(now+60000,job.participant_id,now).run();
    if (!claimed.meta.changes) continue;
    try {
      const thread=await ensureThread(discord,job);
      await discord.request('PUT',`/channels/${thread.id}/thread-members/${job.user_id}`);
      await db.prepare('DELETE FROM thread_join_jobs WHERE participant_id=?').bind(job.participant_id).run();
    } catch(error) {
      const delay=error instanceof DiscordError ? error.retryAfterMs : 0;
      const stop=job.attempts>=5;
      await db.prepare('UPDATE thread_join_jobs SET next_at=?,attempts=attempts+1 WHERE participant_id=?')
        .bind(stop?Number.MAX_SAFE_INTEGER:now+Math.max(delay,60000 * 2**job.attempts),job.participant_id).run();
      console.warn('thread_join_failed',job.participant_id,error instanceof DiscordError?error.status:'internal');
    }
  }
}
