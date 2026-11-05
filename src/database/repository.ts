import { emptyDraft, validateDraft } from '../domain';
import { UserError, type Draft, type DraftData, type Recruitment, type Scope } from '../types';

export class Repository {
  constructor(readonly db: D1Database) {}
  async createDraft(id: string, scope: Scope, now = Date.now()): Promise<Draft> {
    await this.db.prepare('INSERT OR IGNORE INTO drafts(id,guild_id,channel_id,owner_id,payload,expires_at) VALUES(?,?,?,?,?,?)')
      .bind(id, scope.guildId, scope.channelId, scope.userId, JSON.stringify(emptyDraft(now)), now + 900000).run();
    return this.draft(id, scope, now);
  }
  async draft(id: string, scope: Scope, now = Date.now()): Promise<Draft> {
    const draft = await this.db.prepare('SELECT * FROM drafts WHERE id=? AND guild_id=? AND channel_id=? AND owner_id=?')
      .bind(id, scope.guildId, scope.channelId, scope.userId).first<Draft>();
    if (!draft || draft.expires_at <= now) throw new UserError('작성 시간이 만료되었거나 사용할 수 없는 패널입니다. /모집을 다시 실행해 주세요.');
    return draft;
  }
  async discardDraft(draft: Draft): Promise<void> {
    const result = await this.db.prepare('UPDATE drafts SET expires_at=0,version=version+1 WHERE id=? AND version=? AND consumed_by IS NULL AND expires_at>?')
      .bind(draft.id, draft.version, Date.now()).run();
    if (!result.meta.changes) throw new UserError('최신 패널에서 모집 상태를 확인해 주세요.');
  }
  async saveDraft(draft: Draft, data: DraftData): Promise<Draft> {
    const result = await this.db.prepare('UPDATE drafts SET payload=?,version=version+1 WHERE id=? AND version=? AND consumed_by IS NULL AND expires_at>?')
      .bind(JSON.stringify(data), draft.id, draft.version, Date.now()).run();
    if (!result.meta.changes) throw new UserError('작성 내용이 변경되었거나 이미 게시했습니다. 최신 패널에서 다시 시도해 주세요.');
    return { ...draft, payload: JSON.stringify(data), version: draft.version + 1 };
  }
  async publishDraft(draft: Draft, data: DraftData, now = Date.now()): Promise<Recruitment> {
    const valid = validateDraft(data, now);
    const claim = crypto.randomUUID();
    const result = await this.db.batch([
      this.db.prepare('UPDATE drafts SET consumed_by=?,version=version+1 WHERE id=? AND version=? AND consumed_by IS NULL AND expires_at>?')
        .bind(claim, draft.id, draft.version, now),
      this.db.prepare(`INSERT INTO recruitments(id,guild_id,channel_id,owner_id,games_json,role_ids_json,starts_at,ends_at,max_members,time_label,status,created_at,updated_at)
        SELECT id,guild_id,channel_id,owner_id,?,?,?,?,?,?,'publishing',?,? FROM drafts WHERE id=? AND consumed_by=?`)
        .bind(JSON.stringify(valid.games), JSON.stringify(valid.roles), valid.startsAt, valid.endsAt, valid.maximum, valid.timeLabel, now, now, draft.id, claim),
      this.db.prepare(`INSERT INTO participants(id,recruitment_id,user_id,joined_at)
        SELECT ?,id,owner_id,? FROM drafts WHERE id=? AND consumed_by=?`)
        .bind(crypto.randomUUID(), now, draft.id, claim),
    ]);
    if (!result[0]!.meta.changes) throw new UserError('이미 게시했거나 작성 내용이 변경되었습니다. 최신 패널을 확인해 주세요.');
    await this.db.prepare('UPDATE recruitments SET creator_id=owner_id WHERE id=? AND creator_id IS NULL').bind(draft.id).run();
    return (await this.recruitment(draft.id))!;
  }
  async recruitment(id: string): Promise<Recruitment | null> {
    return this.db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM participants WHERE recruitment_id=r.id) AS member_count FROM recruitments r WHERE id=?`)
      .bind(id).first<Recruitment>();
  }
  async participants(id: string, scope: Scope, messageId: string) {
    const result = await this.db.prepare(`SELECT p.user_id, r.owner_id FROM participants p
      JOIN recruitments r ON r.id=p.recruitment_id
      WHERE r.id=? AND r.guild_id=? AND r.channel_id=? AND r.message_id=?
      ORDER BY (p.user_id=r.owner_id) DESC, p.joined_at, p.user_id`)
      .bind(id, scope.guildId, scope.channelId, messageId).all<{ user_id: string; owner_id: string }>();
    if (!result.results.length) throw new UserError('사용할 수 없는 모집입니다.');
    return result.results;
  }
  async act(interactionId: string, id: string, scope: Scope, messageId: string, action: 'join' | 'leave' | 'cancel', now = Date.now()): Promise<string> {
    const claim = crypto.randomUUID();
    // 판정·참가 변경·결과 저장을 같은 batch로 묶어 재전송과 동시 조작을 분리한다.
    const specific = action === 'join'
      ? `WHEN EXISTS(SELECT 1 FROM participants WHERE recruitment_id=r.id AND user_id=?3) THEN 'already_joined'
         WHEN EXISTS(SELECT 1 FROM waiting WHERE recruitment_id=r.id AND user_id=?3 AND promoted=0) THEN 'already_waiting'
         WHEN EXISTS(SELECT 1 FROM waiting WHERE recruitment_id=r.id AND promoted=0) OR (SELECT COUNT(*) FROM participants WHERE recruitment_id=r.id)>=r.max_members THEN 'waiting' ELSE 'joined'`
      : action === 'leave'
        ? `WHEN r.owner_id=?3 THEN 'owner_fixed'
           WHEN EXISTS(SELECT 1 FROM waiting WHERE recruitment_id=r.id AND user_id=?3 AND promoted=0) THEN 'unwaited'
           WHEN NOT EXISTS(SELECT 1 FROM participants WHERE recruitment_id=r.id AND user_id=?3) THEN 'not_joined' ELSE 'left'`
        : `WHEN r.owner_id!=?3 THEN 'not_owner' ELSE 'cancelled'`;
    const receipt = this.db.prepare(`INSERT OR IGNORE INTO interaction_receipts(interaction_id,claim,result,created_at)
      VALUES(?6,?7,COALESCE((SELECT CASE
        WHEN r.guild_id!=?4 OR r.channel_id!=?5 OR r.message_id!=?8 THEN 'unavailable'
        WHEN r.status!='open' OR r.completed=1 OR r.ends_at<=?2 THEN 'closed'
        ${specific} END FROM recruitments r WHERE r.id=?1),'unavailable'),?2)`)
      .bind(id, now, scope.userId, scope.guildId, scope.channelId, interactionId, claim, messageId);
    const guard = 'EXISTS(SELECT 1 FROM interaction_receipts WHERE interaction_id=? AND claim=? AND result=?)';
    const mutation = action === 'join'
      ? this.db.prepare(`INSERT INTO participants(id,recruitment_id,user_id,joined_at) SELECT ?,?,?,? WHERE ${guard}`)
        .bind(crypto.randomUUID(), id, scope.userId, now, interactionId, claim, 'joined')
      : action === 'leave'
        ? this.db.prepare(`DELETE FROM participants WHERE recruitment_id=? AND user_id=? AND ${guard}`)
          .bind(id, scope.userId, interactionId, claim, 'left')
        : this.db.prepare(`UPDATE recruitments SET status='cancelled' WHERE id=? AND ${guard}`)
          .bind(id, interactionId, claim, 'cancelled');
    const results = await this.db.batch([receipt, mutation,
      this.db.prepare(`INSERT INTO waiting(recruitment_id,user_id) SELECT ?,? WHERE ${guard}`).bind(id,scope.userId,interactionId,claim,'waiting'),
      this.db.prepare(`DELETE FROM waiting WHERE recruitment_id=? AND user_id=? AND EXISTS(SELECT 1 FROM interaction_receipts WHERE interaction_id=? AND claim=? AND result IN ('left','unwaited'))`).bind(id,scope.userId,interactionId,claim),
      this.db.prepare('SELECT result FROM interaction_receipts WHERE interaction_id=?').bind(interactionId)]);
    return (results[4]!.results[0] as { result: string }).result;
  }
  async editDraft(draft: Draft, data: DraftData, scope: Scope) {
    const now = Date.now();
    const claim = crypto.randomUUID();
    const r = await this.recruitment(draft.edit_id!);
    if (!r) throw new UserError('모집을 찾을 수 없습니다.');
    const label = (data.timeText ?? [data.start,data.end].filter(Boolean).join(' ~ ')).trim();
    const sameStart = label.split(/\s*[~–-]\s*/)[0] === r.time_label?.split(/\s*[~–-]\s*/)[0];
    const v = validateDraft(data,now,sameStart ? r.starts_at : undefined);
    const result = await this.db.batch([
      this.db.prepare(`UPDATE drafts SET consumed_by=?,version=version+1 WHERE id=? AND version=? AND consumed_by IS NULL AND expires_at>?
        AND EXISTS(SELECT 1 FROM recruitments r WHERE r.id=drafts.edit_id AND r.guild_id=? AND r.channel_id=? AND r.owner_id=? AND r.status='open' AND r.completed=0 AND r.ends_at>? AND r.version=? AND (SELECT COUNT(*) FROM participants WHERE recruitment_id=r.id)<=?)`)
        .bind(claim,draft.id,draft.version,now,scope.guildId,scope.channelId,scope.userId,now,r.version,v.maximum),
      this.db.prepare(`UPDATE recruitments SET games_json=?,role_ids_json=?,starts_at=?,ends_at=?,max_members=?,time_label=? WHERE id=? AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND consumed_by=?)`)
        .bind(JSON.stringify(v.games),JSON.stringify(v.roles),v.startsAt,v.endsAt,v.maximum,v.timeLabel,r.id,draft.id,claim)
    ]);
    if (!result[0]!.meta.changes) throw new UserError('모집자, 명단 또는 모집 상태가 변경됐습니다. 정원을 확인하고 다시 시도해 주세요.');
  }
  async maintenance(now = Date.now()): Promise<void> {
    // 한 번에 처리할 모집 수를 제한하여 무료 CPU/쿼리 한도를 보호한다.
    await this.db.batch([
      this.db.prepare("UPDATE recruitments SET status='ended' WHERE id IN (SELECT id FROM recruitments WHERE status='open' AND completed=0 AND ends_at<=? LIMIT 50)").bind(now),
      // 늦게 도착한 Discord 응답 등으로 작업 행이 없는데 표시가 뒤처진 경우도 복구한다.
      this.db.prepare(`INSERT INTO message_jobs(recruitment_id)
        SELECT id FROM recruitments r WHERE r.message_id IS NOT NULL AND r.next_reconcile_at<=?
          AND r.ends_at>? AND r.status IN ('open','cancelled','ended')
          AND NOT EXISTS(SELECT 1 FROM message_jobs j WHERE j.recruitment_id=r.id)
        ORDER BY r.next_reconcile_at LIMIT 5`).bind(now, now - 86400000),
      this.db.prepare('DELETE FROM drafts WHERE id IN (SELECT id FROM drafts WHERE expires_at<? LIMIT 100)').bind(now - 86400000),
      this.db.prepare('DELETE FROM interaction_receipts WHERE interaction_id IN (SELECT interaction_id FROM interaction_receipts WHERE created_at<? LIMIT 100)').bind(now - 7 * 86400000),
    ]);
  }
}
