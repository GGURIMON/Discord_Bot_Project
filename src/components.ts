import { gamesOf } from './domain';
import { formatContent, seoulDate, validateDraft } from './domain';
import type { Component, Draft, DraftData, MessagePayload, Recruitment, Role } from './types';

export const NO_MENTIONS = { parse: [] as string[], roles: [] as string[], users: [] as string[], replied_user: false };
export const row = (...components: Component[]): Component => ({ type: 1, components });
export const button = (custom_id: string, label: string, style = 2, disabled = false): Component => ({ type: 2, custom_id, label, style, disabled });
export function privateText(content: string): MessagePayload { return { content, components: [], allowed_mentions: NO_MENTIONS }; }

export function draftPanel(draft: Draft, page = 0, notice = '', now = Date.now()): MessagePayload {
  const data: DraftData = JSON.parse(draft.payload);
  const key = `d:${draft.id}:${draft.version}`;
  let preview = '';
  let problem = '';
  try {
    const value = validateDraft(data, now);
    preview = formatContent(draft.owner_id, value.games, value.startsAt, value.endsAt, 1, value.maximum, value.roles, 'open', value.timeLabel);
  } catch (error) { problem = error instanceof Error ? error.message : '입력을 확인해 주세요.';
    if (data.customGames) {
      preview = [data.customGames, data.timeText, data.maximum && `최대 ${data.maximum}명`, data.roles.map(role => `<@&${role.id}>`).join(', '), problem].filter(Boolean).join('\n');
    } }
  if (draft.consumed_by) return privateText('모집 게시를 접수했습니다. 이 패널은 다시 게시할 수 없습니다.');
  const components = [
    row(button(`${key}:details:${page}`, '모집 내용 입력', 1), button(`${key}:publish:${page}`, draft.edit_id ? '✅ 수정 저장' : '✅ 모집 게시', 3, Boolean(problem)), button(`${key}:discard:${page}`, '작성 취소', 4)),
  ];
  // 미리보기는 2,000자 제한을 별도로 지키며 게시글에는 전체 내용을 쓴다.
  return { content: `${notice ? `${notice}\n\n` : ''}**모집 작성**\n${preview || problem}`.slice(0, 2000), components, allowed_mentions: NO_MENTIONS };
}
export function detailsModal(draft: Draft, page: number, roles: Role[]) {
  const data: DraftData = JSON.parse(draft.payload);
  const field = (id: string, label: string, placeholder: string, value: string, required: boolean, max: number, style = 1): Component => ({
    type: 18, label, component: { type: 4, custom_id: id, style, required, max_length: max, placeholder, ...(value ? { value } : {}) },
  });
  return { type: 9, data: { custom_id: `d:${draft.id}:${draft.version}:submitRoles:${page}`, title: draft.edit_id ? '모집 내용 수정' : '모집 상세 입력', components: [
    field('gameText', '게임 이름', '증바람', data.gameIds.length ? gamesOf({ ...data, customGames: '' }).map(g => g.mode ? `${g.name}(${g.mode})` : g.name).concat(data.customGames || []).join('\n') : data.customGames, true, 1200, 2),
    field('timeText', '시간', '지금 / 13:00 / 13:00 ~ 14:30', data.timeText ?? ([data.start, data.end].filter(Boolean).join(' ~ ') || '지금'), true, 40),
    ...(roles.length ? [{
      type: 18, label: '알릴 역할', component: {
        type: 3, custom_id: 'roleIds', placeholder: '알릴 역할을 하나 이상 선택하세요', required: true,
        min_values: 1, max_values: roles.length,
        options: roles.map(role => ({ label: role.name, value: role.id, default: data.roles.some(r => r.id === role.id) })),
      },
    }] : []),
    field('maximum', '최대 인원 (모집자 포함)', '5', data.maximum, true, 3),
  ] } };
}
export function recruitmentMessage(recruitment: Recruitment, notify = false, now = Date.now()): MessagePayload {
  const closed = Boolean(recruitment.completed) || recruitment.status !== 'open' && recruitment.status !== 'publishing' || recruitment.ends_at <= now;
  const roles: string[] = JSON.parse(recruitment.role_ids_json);
  return {
    content: formatContent(recruitment.owner_id, JSON.parse(recruitment.games_json), recruitment.starts_at, recruitment.ends_at, recruitment.member_count, recruitment.max_members, roles, recruitment.completed ? 'completed' : recruitment.status, recruitment.time_label),
    components: [row(
      button(`r:${recruitment.id}:join`, '참가하기', 3, closed),
      button(`r:${recruitment.id}:leave`, '참가 취소', 2, closed),
      button(`r:${recruitment.id}:manage`, '모집 관리', 2, closed),
      button(`r:${recruitment.id}:members`, '참가자·대기자 목록'),
    ), row(button(`r:${recruitment.id}:edit`, '내용 수정', 2, closed), button(`r:${recruitment.id}:transferInbox`, '위임 수락/거절', 2, closed))],
    allowed_mentions: notify ? { parse: [], roles, users: [], replied_user: false } : NO_MENTIONS,
  };
}
