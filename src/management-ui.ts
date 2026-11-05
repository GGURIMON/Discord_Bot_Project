import type { Discord } from './services/discord';
import { button, row, privateText } from './components';
import { manage, scoped } from './database/management';
import { Repository } from './database/repository';
import { emptyDraft, clockTime, seoulDate } from './domain';
import { UserError, type Interaction, type Scope, type Recruitment, type DraftData } from './types';

export async function seedDraft(repo: Repository, event: string, scope: Scope, r: Recruitment, edit: boolean) {
  const draft = await repo.createDraft(event, scope);
  const data: DraftData = { ...emptyDraft(),
    customGames: JSON.parse(r.games_json).map((g: {name:string;mode?:string}) => g.name + (g.mode ? `(${g.mode})` : '')).join('\n'),
    maximum: String(r.max_members), timeText: r.time_label ?? `${clockTime(r.starts_at)} ~ ${clockTime(r.ends_at)}`,
    date: edit ? seoulDate(r.starts_at) : seoulDate(),
    roles: JSON.parse(r.role_ids_json).map((id:string) => ({id,name:id,mentionable:false})),
  };
  await repo.db.prepare('UPDATE drafts SET edit_id=? WHERE id=?').bind(edit ? r.id : null,draft.id).run();
  return {...await repo.saveDraft(draft,data),edit_id:edit ? r.id : null};
}
export async function managementUI(repo: Repository, discord: Discord, interaction: Interaction, scope: Scope) {
  const [prefix,id,action,message,target] = (interaction.data?.custom_id ?? '').split(':');
  if (prefix !== 'm' && !(prefix === 'r' && ['manage','transferInbox','askComplete'].includes(action!))) return null;
  const msg = prefix === 'r' ? interaction.message?.id : message;
  if (!id || !msg) throw new UserError('모집 메시지가 없습니다.');
  const ownerAction = !['transferInbox','accept','reject'].includes(action!);
  const r = await scoped(repo,id,scope,msg,ownerAction);
  if (r.completed || r.status !== 'open' || r.ends_at<=Date.now()) throw new UserError('마감된 모집입니다.');
  const key = `m:${id}`;
  if (action === 'manage') return {...privateText('모집 관리'),components:[row(
    button(`${key}:choosePromote:${msg}`,'대기자 참가 전환'),button(`${key}:chooseRestore:${msg}`,'참가 전환 복원'),
    button(`${key}:chooseOffer:${msg}`,'권한 위임'),button(`${key}:askComplete:${msg}`,'모집 완료'),button(`${key}:askCancel:${msg}`,'모집 취소',4))]};

  if (action === 'askCancel') return {...privateText('모집을 취소하시겠습니까?'),components:[row(button(`r:${id}:cancel:${msg}`,'모집 취소 확인',4),button('dismiss','돌아가기'))]};
  if (action === 'askComplete') return {...privateText('모집 완료 하시겠습니까?'),components:[row(button(`${key}:complete:${msg}`,'완료 확인',3),button('dismiss','돌아가기'))]};
  if (action === 'transferInbox') {
    const pending = await repo.db.prepare("SELECT id FROM transfers WHERE recruitment_id=? AND from_user=? AND to_user=? AND state='pending' AND expires_at>? ORDER BY expires_at DESC LIMIT 1").bind(id,r.owner_id,scope.userId,Date.now()).first<{id:string}>();
    if (!pending) return privateText('받은 위임 요청이 없습니다.');
    return {...privateText('모집자 권한 위임을 수락하시겠습니까?'),components:[row(button(`${key}:accept:${msg}:${pending.id}`,'수락',3),button(`${key}:reject:${msg}:${pending.id}`,'거절',4))]};
  }
  if (action?.startsWith('choose')) {
    const kind = action.slice(6).toLowerCase();
    const page = Math.max(0,Number(target)||0);
    const sql = kind === 'offer' ? 'SELECT user_id FROM participants WHERE recruitment_id=? AND user_id!=? ORDER BY joined_at,user_id'
      : `SELECT user_id FROM waiting WHERE recruitment_id=? AND user_id!=? AND promoted=${kind==='restore'?1:0} ORDER BY sequence`;
    const pageSize = 10;
    const users = await repo.db.prepare(sql+' LIMIT 11 OFFSET ?').bind(id,r.owner_id,page*pageSize).all<{user_id:string}>();
    if (!users.results.length) return privateText('선택할 사용자가 없습니다.');
    const candidates = users.results.slice(0,pageSize);
    const options = await Promise.all(candidates.map(async (user,i) => {
      const name = await discord.memberDisplayName(scope.guildId,user.user_id).catch(()=>null);
      const number = page*pageSize+i+1;
      return {label:`${number}. ${name || '아래 명단에서 확인'}`,value:user.user_id};
    }));
    const roster = candidates.map((user,i)=>`${page*pageSize+i+1}. <@${user.user_id}>`).join('\n');
    return {...privateText(`대상을 선택해 주세요.\n${roster}`),components:[
      row({type:3,custom_id:`${key}:ask${kind}:${msg}`,options}),
      row(button(`${key}:${action}:${msg}:${page-1}`,'이전',2,page===0),
          button(`${key}:${action}:${msg}:${page+1}`,'다음',2,users.results.length<=pageSize))]};
  }
  if (action?.startsWith('ask')) {
    const user = interaction.data?.values?.[0];
    if (!user || !/^\d+$/.test(user)) throw new UserError('대상을 선택해 주세요.');
    const question = action === 'askoffer' ? '권한을 위임하시겠습니까?'
      : action === 'askrestore' ? '대기자로 복원하시겠습니까?' : '참가자로 전환하시겠습니까?';
    return {...privateText(`대상: <@${user}>\n${question}`),components:[row(button(`${key}:${action.slice(3)}:${msg}:${user}`,'확인',3),button('dismiss','돌아가기'))]};
  }
  if (!['promote','restore','offer','complete','accept','reject'].includes(action!)) throw new UserError('잘못된 관리 요청입니다.');
  const result = await manage(repo,interaction.id,id,scope,msg,action!,target);
  if (result === 'offer_replayed') return privateText('이미 접수된 위임 요청입니다.');
  if (action === 'offer' && result === 'managed' && target) {
    try {
      await discord.notifyTransfer(target,interaction.id,`https://discord.com/channels/${scope.guildId}/${scope.channelId}/${msg}`);
      return privateText('위임 요청을 등록하고 대상자에게 개인 메시지를 보냈습니다.');
    } catch {
      return privateText('위임 요청은 등록됐지만 개인 메시지 전달을 확인하지 못했습니다. 대상자는 모집글 설정의 ‘위임 응답’에서 확인할 수 있습니다.');
    }
  }
  return privateText(result === 'managed' ? '변경했습니다.' : '권한이나 명단이 변경됐거나 빈자리가 없습니다. 최신 상태에서 다시 시도해 주세요.');
}
