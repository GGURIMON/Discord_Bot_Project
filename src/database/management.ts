import { Repository } from './repository';
import { UserError, type Scope } from '../types';

export async function scoped(repo: Repository, id: string, scope: Scope, message: string, owner = false) {
  const r = await repo.recruitment(id);
  if (!r || r.guild_id !== scope.guildId || r.channel_id !== scope.channelId || r.message_id !== message)
    throw new UserError('사용할 수 없는 모집입니다.');
  if (owner && r.owner_id !== scope.userId) throw new UserError('모집자만 관리할 수 있습니다.');
  return r;
}

// Receipt 판정과 모든 변경을 D1의 동일 트랜잭션에서 실행한다.
export async function manage(repo: Repository, event: string, id: string, scope: Scope, message: string,
  action: string, target = '', now = Date.now()) {
  const claim = crypto.randomUUID();
  const p = (sql: string) => repo.db.prepare(sql);
  const targetMember = 'EXISTS(SELECT 1 FROM participants WHERE recruitment_id=r.id AND user_id=?9)';
  const waiting = 'EXISTS(SELECT 1 FROM waiting WHERE recruitment_id=r.id AND user_id=?9 AND promoted=0)';
  const room = '(SELECT COUNT(*) FROM participants WHERE recruitment_id=r.id)<r.max_members';
  let condition = '0';
  if (action === 'promote') condition = `${waiting} AND ${room}`;
  if (action === 'restore') condition = `${targetMember} AND ?9!=r.owner_id AND EXISTS(SELECT 1 FROM waiting WHERE recruitment_id=r.id AND user_id=?9 AND promoted=1)`;
  if (action === 'complete') condition = '1';
  if (action === 'offer') condition = `${targetMember} AND ?9!=r.owner_id`;
  if (action === 'accept' || action === 'reject') condition = `EXISTS(SELECT 1 FROM transfers t WHERE t.id=?9 AND t.recruitment_id=r.id AND t.from_user=r.owner_id AND t.to_user=?3 AND t.state='pending' AND t.expires_at>?2 AND EXISTS(SELECT 1 FROM participants WHERE recruitment_id=r.id AND user_id=?3))`;
  const receipt = p(`INSERT OR IGNORE INTO interaction_receipts VALUES(?6,?7,
    COALESCE((SELECT CASE WHEN r.guild_id!=?4 OR r.channel_id!=?5 OR r.message_id!=?8 THEN 'unavailable'
      WHEN r.status!='open' OR r.completed=1 OR r.ends_at<=?2 THEN 'closed'
      WHEN ?10 NOT IN ('accept','reject') AND r.owner_id!=?3 THEN 'not_owner'
      WHEN ${condition} THEN 'managed' ELSE 'stale' END FROM recruitments r WHERE id=?1),'unavailable'),?2)`)
    .bind(id,now,scope.userId,scope.guildId,scope.channelId,event,claim,message,target,action);
  const guard = `EXISTS(SELECT 1 FROM interaction_receipts WHERE interaction_id='${event.replaceAll("'", "''")}' AND claim='${claim}' AND result='managed')`;
  const statements: D1PreparedStatement[] = [receipt];
  if (action === 'promote') statements.push(
    p(`INSERT INTO participants SELECT ?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),id,target,now),
    p(`UPDATE waiting SET promoted=1 WHERE recruitment_id=? AND user_id=? AND ${guard}`).bind(id,target));
  if (action === 'restore') statements.push(
    p(`DELETE FROM participants WHERE recruitment_id=? AND user_id=? AND ${guard}`).bind(id,target),
    p(`UPDATE waiting SET promoted=0 WHERE recruitment_id=? AND user_id=? AND ${guard}`).bind(id,target));
  if (action === 'complete') statements.push(p(`UPDATE recruitments SET completed=1 WHERE id=? AND ${guard}`).bind(id));
  if (action === 'offer') statements.push(p(`INSERT INTO transfers(id,recruitment_id,from_user,to_user,expires_at) SELECT ?,?,?,?,? WHERE ${guard}`).bind(event,id,scope.userId,target,now+900000));
  if (action === 'accept') statements.push(p(`UPDATE recruitments SET owner_id=? WHERE id=? AND ${guard}`).bind(scope.userId,id));
  if (action === 'accept' || action === 'reject') statements.push(p(`UPDATE transfers SET state=? WHERE id=? AND ${guard}`).bind(action,target));
  statements.push(p('SELECT result FROM interaction_receipts WHERE interaction_id=?').bind(event));
  const results = await repo.db.batch(statements);
  return (results.at(-1)!.results[0] as {result:string}).result;
}
