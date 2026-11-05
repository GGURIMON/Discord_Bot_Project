import { button, row, privateText, draftPanel } from './components';
import { manage, scoped } from './database/management';
import { Repository } from './database/repository';
import { emptyDraft, clockTime, seoulDate } from './domain';
import { UserError, type Interaction, type Scope, type Recruitment, type DraftData } from './types';

export async function seedDraft(repo: Repository, event: string, scope: Scope, r: Recruitment, edit: boolean) {
  const draft = await repo.createDraft(event, scope);
  const data: DraftData = { ...emptyDraft(),
    customGames: JSON.parse(r.games_json).map((g: {name:string;mode?:string}) => g.name + (g.mode ? `(${g.mode})` : '')).join('\n'),
    maximum: String(r.max_members), timeText: edit ? r.time_label ?? `${clockTime(r.starts_at)} ~ ${clockTime(r.ends_at)}` : '',
    date: edit ? seoulDate(r.starts_at) : seoulDate(),
    roles: JSON.parse(r.role_ids_json).map((id:string) => ({id,name:id,mentionable:false})),
  };
  await repo.db.prepare('UPDATE drafts SET edit_id=? WHERE id=?').bind(edit ? r.id : null,draft.id).run();
  return draftPanel({...await repo.saveDraft(draft,data),edit_id:edit ? r.id : null});
}
export async function managementUI(repo: Repository, interaction: Interaction, scope: Scope) {
  const [prefix,id,action,message,target] = (interaction.data?.custom_id ?? '').split(':');
  if (prefix !== 'm' && !(prefix === 'r' && ['manage','transferInbox'].includes(action!))) return null;
  const msg = prefix === 'r' ? interaction.message?.id : message;
  if (!id || !msg) throw new UserError('모집 메시지가 없습니다.');
  const ownerAction = !['transferInbox','accept','reject'].includes(action!);
  const r = await scoped(repo,id,scope,msg,ownerAction);
  if (r.completed || r.status !== 'open' || r.ends_at<=Date.now()) throw new UserError('마감된 모집입니다.');
  const key = `m:${id}`;
  if (action === 'manage') return {...privateText('모집 관리'),components:[row(
    button(`${key}:choosePromote:${msg}`,'대기자 참가 전환'),button(`${key}:chooseRestore:${msg}`,'참가 전환 복원'),
    button(`${key}:chooseOffer:${msg}`,'권한 위임'),button(`${key}:askComplete:${msg}`,'모집 완료'),button(`${key}:edit:${msg}`,'내용 수정'))]};
  if (action === 'edit') return seedDraft(repo,interaction.id,scope,r,true);
  if (action === 'askComplete') return {...privateText('모집을 완료할까? 기존 명단은 유지돼.'),components:[row(button(`${key}:complete:${msg}`,'완료 확인',3),button('dismiss','돌아가기'))]};
  if (action === 'transferInbox') {
    const pending = await repo.db.prepare("SELECT id FROM transfers WHERE recruitment_id=? AND from_user=? AND to_user=? AND state='pending' AND expires_at>? ORDER BY expires_at DESC LIMIT 1").bind(id,r.owner_id,scope.userId,Date.now()).first<{id:string}>();
    if (!pending) return privateText('받은 위임 요청이 없습니다.');
    return {...privateText('모집자 권한 위임을 수락할까?'),components:[row(button(`${key}:accept:${msg}:${pending.id}`,'수락',3),button(`${key}:reject:${msg}:${pending.id}`,'거절',4))]};
  }
  if (action?.startsWith('choose')) {
    const kind = action.slice(6).toLowerCase();
    const page = Math.max(0,Number(target)||0);
    const sql = kind === 'offer' ? 'SELECT user_id FROM participants WHERE recruitment_id=? AND user_id!=? ORDER BY joined_at,user_id'
      : `SELECT user_id FROM waiting WHERE recruitment_id=? AND user_id!=? AND promoted=${kind==='restore'?1:0} ORDER BY sequence`;
    const users = await repo.db.prepare(sql+' LIMIT 26 OFFSET ?').bind(id,r.owner_id,page*25).all<{user_id:string}>();
    if (!users.results.length) return privateText('선택할 사용자가 없습니다.');
    return {...privateText('대상 선택 후 확인 버튼을 눌러 주세요.'),components:[row({type:3,custom_id:`${key}:ask${kind}:${msg}`,options:users.results.slice(0,25).map((u,i)=>({label:`${page*25+i+1}. ${u.user_id}`,value:u.user_id}))}),row(button(`${key}:${action}:${msg}:${page-1}`,'이전',2,page===0),button(`${key}:${action}:${msg}:${page+1}`,'다음',2,users.results.length<=25))]};
  }
  if (action?.startsWith('ask')) {
    const user = interaction.data?.values?.[0];
    if (!user || !/^\d+$/.test(user)) throw new UserError('대상을 선택해 주세요.');
    return {...privateText(`<@${user}> 대상으로 진행할까?`),components:[row(button(`${key}:${action.slice(3)}:${msg}:${user}`,'확인',3),button('dismiss','돌아가기'))]};
  }
  if (!['promote','restore','offer','complete','accept','reject'].includes(action!)) throw new UserError('잘못된 관리 요청입니다.');
  const result = await manage(repo,interaction.id,id,scope,msg,action!,target);
  return privateText(result === 'managed' ? action==='offer' ? '위임 요청을 저장했습니다. 대상자가 모집글의 위임 수락/거절 버튼에서 수락해야 해요. (15분 유효)' : '변경했습니다.' : '권한이나 명단이 변경됐거나 빈자리가 없습니다. 최신 상태에서 다시 시도해 주세요.');
}
