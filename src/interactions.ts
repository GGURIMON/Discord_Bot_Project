import { scoped } from './database/management';
import { managementUI, seedDraft } from './management-ui';
import { GAMES } from './config/games';
import { button, detailsModal, draftPanel, NO_MENTIONS, privateText, row } from './components';
import { Repository } from './database/repository';
import { validateDraft } from './domain';
import { Discord, DiscordError } from './services/discord';
import { MessageSync } from './services/sync';
import { UserError, type Component, type Draft, type DraftData, type Interaction, type MessagePayload, type Scope, type Role } from './types';

const gameRoleNames = new Set(['리그오브레전드', '오버워치', 'FPS', '기타', 'TFT(롤체)', '스팀', '배틀그라운드', 'RPG', '발로란트']);
const shortRoleName = (name: string) => name.trim().replace(/\(모든장르\)$/, '');
function gameRoles(roles: Role[], guildId: string) {
  return roles.filter(role => !role.managed && role.id !== guildId && gameRoleNames.has(shortRoleName(role.name))).slice(0, 25);
}

const editSaved = privateText('모집글에 수정을 반영했습니다.');
const closeCancelledPanel = privateText('모집을 취소했습니다.');
const resultTexts: Record<string, string> = {
  waiting: '대기 신청했습니다.', already_waiting: '이미 대기 중입니다.', unwaited: '대기를 취소했습니다.', joined: '참가했습니다.', left: '참가를 취소했습니다.', cancelled: '모집을 취소했습니다.',
  already_joined: '이미 참가 중입니다.', not_joined: '참가 중인 모집이 아닙니다.',
  full: '정원이 가득 찼습니다.', closed: '취소되었거나 종료된 모집입니다.',
  owner_fixed: '모집자는 기본 참가자로 고정됩니다. 전체 취소는 모집 취소 버튼을 눌러 주세요.',
  not_owner: '모집자만 모집을 취소할 수 있습니다.', unavailable: '사용할 수 없는 모집입니다.',
};
function getScope(interaction: Interaction): Scope {
  if (!interaction.guild_id || !interaction.channel_id || !interaction.member?.user.id) throw new UserError('서버 채널에서 /모집을 실행해 주세요.');
  return { guildId: interaction.guild_id, channelId: interaction.channel_id, userId: interaction.member.user.id };
}
function parseDraftId(customId: string) {
  const [prefix, id, revision, action, pageRaw] = customId.split(':');
  if (prefix !== 'd' || !id || !/^\d+$/.test(id) || !revision || !/^\d+$/.test(revision) || !action) throw new UserError('올바르지 않은 입력입니다.');
  return { id, version: Number(revision), action, page: Number(pageRaw) || 0 };
}
function modalFields(components: Component[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  for (const component of components) {
    if (component.custom_id && typeof component.value === 'string') values[component.custom_id] = component.value;
    Object.assign(values, modalFields(component.components ?? (component.component ? [component.component] : [])));
  }
  return values;
}
export class Interactions {
  readonly sync: MessageSync;
  constructor(readonly repo: Repository, readonly discord: Discord) { this.sync = new MessageSync(repo, discord); }
  // Modal은 초기 응답 자체여야 한다. DB 접근에는 별도 짧은 deadline을 적용한다.
  async openModal(interaction: Interaction) {
    const scope = getScope(interaction);
    const customId = interaction.data?.custom_id ?? '';
    const edit = /^([rm]):(\d+):edit(?::(\d+))?$/.exec(customId);
    if (edit) {
      const messageId = edit[1] === 'r' ? interaction.message?.id : edit[3];
      const r = await scoped(this.repo,edit[2]!,scope,messageId ?? '',true);
      if (r.completed || r.status !== 'open' || r.ends_at <= Date.now()) throw new UserError('마감된 모집입니다.');
      const [draft, roles] = await Promise.all([seedDraft(this.repo,interaction.id,scope,r,true), this.discord.roles(scope.guildId)]);
      return detailsModal(draft,0,gameRoles(roles,scope.guildId));
    }
    const parsed = parseDraftId(customId);
    const [draft, roles] = await Promise.all([this.repo.draft(parsed.id, scope), this.discord.roles(scope.guildId)]);
    this.checkVersion(draft, parsed.version);
    return detailsModal(draft, parsed.page, gameRoles(roles, scope.guildId));
  }
  private checkVersion(draft: Draft, version: number) {
    if (draft.consumed_by) throw new UserError('이미 게시를 접수한 모집입니다.');
    if (draft.version !== version) throw new UserError('다른 입력으로 내용이 변경되었습니다. 최신 패널에서 다시 시도해 주세요.');
  }
  async process(interaction: Interaction): Promise<void> {
    let payload: MessagePayload;
    try { payload = await this.handle(interaction); }
    catch (error) {
      const message = error instanceof UserError ? error.message : error instanceof DiscordError
        ? 'Discord 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.' : '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
      console.warn(JSON.stringify({ event: 'interaction_error', interactionId: interaction.id, code: error instanceof UserError ? 'validation' : error instanceof DiscordError ? `discord_${error.status}` : 'internal' }));
      payload = privateText(message);
      if (interaction.data?.custom_id?.startsWith('d:')) {
        try {
          const parsed = parseDraftId(interaction.data.custom_id);
          const draft = await this.repo.draft(parsed.id, getScope(interaction));
          payload = draftPanel(draft, parsed.page, message);
        } catch { /* 만료된 패널은 재실행 안내만 표시한다. */ }
      }
    }
    // 공개 글에서 시작한 작업은 type 5 개인 응답, 개인 패널 안의 작업은 type 6으로 갱신한다.
    const actionId = interaction.data?.custom_id ?? '';
    const terminalManagement = !payload.components.length && (actionId.startsWith('m:') ||
      actionId.endsWith(':transferInbox') || actionId === 'dismiss' || payload === editSaved);
    if (terminalManagement && payload !== editSaved && actionId !== 'dismiss') {
      try {
        await this.discord.reply(interaction,payload);
        await new Promise(resolve=>setTimeout(resolve,3500));
      } catch { return; }
    }
    if (terminalManagement || (payload === closeCancelledPanel && ((interaction.message?.flags ?? 0) & 64))) {
      try {
        await this.discord.deleteReply(interaction);
        return;
      } catch (error) {
        if (error instanceof DiscordError && error.status === 404) return;
        // 삭제에 실패해도 이미 처리된 버튼은 제거한다.
      }
    }
    try { await this.discord.reply(interaction, payload); }
    catch { console.warn(JSON.stringify({ event: 'interaction_reply_failed', interactionId: interaction.id })); }
  }
  async handle(interaction: Interaction): Promise<MessagePayload> {
    const scope = getScope(interaction);
    if (interaction.type === 2) {
      if (interaction.data?.name !== '모집') throw new UserError('지원하지 않는 명령어입니다.');
      const panel = draftPanel(await this.repo.createDraft(interaction.id, scope));
      panel.components.push(row(button('recent','내 최근 모집 복사')));
      return panel;
    }
    const customId = interaction.data?.custom_id ?? '';
    if (customId === 'recent') {
      const recent = await this.repo.db.prepare('SELECT id,games_json FROM recruitments WHERE guild_id=? AND creator_id=? ORDER BY created_at DESC,id DESC LIMIT 5').bind(scope.guildId,scope.userId).all<{id:string;games_json:string}>();
      if (!recent.results.length) return privateText('복사할 모집이 없습니다.');
      return {...privateText('복사할 모집을 선택해 주세요. 기존 시간도 함께 불러옵니다.'),components:[row({type:3,custom_id:'copy',options:recent.results.map((r,i)=>({label:`${i+1}. ${JSON.parse(r.games_json).map((g:{name:string})=>g.name).join(', ')}`.slice(0,100),value:r.id}))})]};
    }
    if (customId === 'copy') {
      const r = await this.repo.recruitment(interaction.data?.values?.[0] ?? '');
      const allowed = await this.repo.db.prepare('SELECT id FROM recruitments WHERE guild_id=? AND creator_id=? ORDER BY created_at DESC,id DESC LIMIT 5').bind(scope.guildId,scope.userId).all<{id:string}>();
      if (!r || !allowed.results.some(x=>x.id===r.id)) throw new UserError('복사할 수 없는 모집입니다.');
      return draftPanel(await seedDraft(this.repo,interaction.id,scope,r,false),0,'이전 모집을 복사했습니다. 시간과 내용을 확인한 뒤 게시해 주세요.');
    }
    const managed = await managementUI(this.repo,interaction,scope);
    if (managed) { const id = customId.split(':')[1]; if (id) await this.sync.run(id); return managed; }
    if (customId.startsWith('d:')) return this.handleDraft(interaction, scope);
    if (customId === 'dismiss') return privateText('모집 취소를 중단했습니다.');
    const [prefix, id, action, sourceMessage, pageText] = customId.split(':');
    if (prefix === 'r' && id && (action === 'members' || action === 'membersPage')) {
      const messageId = action === 'members' ? interaction.message?.id : sourceMessage;
      if (!messageId) throw new UserError('모집 메시지를 확인할 수 없습니다.');
      const members = await this.repo.participants(id, scope, messageId);
      const waiting = await this.repo.db.prepare('SELECT user_id FROM waiting WHERE recruitment_id=? AND promoted=0 ORDER BY sequence').bind(id).all<{user_id:string}>();
      const allLines = [...members.map(member => `<@${member.user_id}>${member.user_id === member.owner_id ? ' (모집자)' : ''}`), `\n대기자 목록 · ${waiting.results.length}명`, ...waiting.results.map((u,i)=>`${i+1}. <@${u.user_id}>`)];
      const pageSize = 40;
      const pages = Math.ceil(allLines.length / pageSize);
      const requested = Number(pageText ?? 0);
      const page = Number.isSafeInteger(requested) ? Math.max(0, Math.min(requested, pages - 1)) : 0;
      const lines = allLines.slice(page * pageSize, (page + 1) * pageSize);
      const panel = privateText([`참가자 목록 · ${members.length}명`, ...lines].join('\n'));
      if (pages > 1) {
        const key = `r:${id}:membersPage:${messageId}`;
        panel.content += `\n${page + 1}/${pages}페이지`;
        panel.components = [row(button(`${key}:${page - 1}`, '이전', 2, page === 0),
          button(`${key}:${page + 1}`, '다음', 2, page === pages - 1))];
      }
      return panel;
    }
    if (prefix !== 'r' || !id || !action || !['join', 'leave', 'askCancel', 'cancel'].includes(action)) throw new UserError('지원하지 않는 버튼입니다.');
    const messageId = action === 'cancel' ? sourceMessage : interaction.message?.id;
    if (!messageId) throw new UserError('모집 메시지를 확인할 수 없습니다.');
    if (action === 'askCancel') {
      const current = await this.repo.recruitment(id);
      if (!current || current.guild_id !== scope.guildId || current.channel_id !== scope.channelId || current.message_id !== messageId) throw new UserError('사용할 수 없는 모집입니다.');
      if (current.owner_id !== scope.userId) throw new UserError('모집자만 모집을 취소할 수 있습니다.');
      if (current.status !== 'open' || current.ends_at <= Date.now()) throw new UserError('이미 취소되었거나 종료된 모집입니다.');
      return { ...privateText('모집을 취소할까요?'), components: [row(button(`r:${id}:cancel:${messageId}`, '모집 취소 확인', 4), button('dismiss', '돌아가기'))] };
    }
    const result = await this.repo.act(interaction.id, id, scope, messageId, action as 'join' | 'leave' | 'cancel');
    await this.sync.run(id);
    const pending = await this.repo.db.prepare('SELECT blocked FROM message_jobs WHERE recruitment_id=?').bind(id).first<{ blocked: number }>();
    if (action === 'cancel' && result === 'cancelled' && !pending) return closeCancelledPanel;
    return privateText(`${resultTexts[result] ?? '처리했습니다.'}${pending ? pending.blocked ? '\n인원은 저장됐지만 메시지 갱신에 문제가 있습니다. 운영자에게 알려 주세요.' : '\n인원은 저장됐으며 메시지 갱신을 재시도하고 있습니다.' : ''}`);
  }
  private async handleDraft(interaction: Interaction, scope: Scope): Promise<MessagePayload> {
    const parsed = parseDraftId(interaction.data?.custom_id ?? '');
    let draft = await this.repo.draft(parsed.id, scope);
    if (draft.consumed_by) {
      const existing = await this.repo.recruitment(draft.id);
      return this.publishedPanel(existing?.message_id ?? null, scope, existing?.status === 'publish_failed');
    }
    if (parsed.action === 'page') return draftPanel(draft, parsed.page);
    this.checkVersion(draft, parsed.version);
    if (parsed.action === 'discard') {
      await this.repo.discardDraft(draft);
      return privateText(draft.edit_id ? '모집 수정을 취소했습니다.' : '모집 작성을 취소했습니다.');
    }
    const data: DraftData = JSON.parse(draft.payload);
    if (parsed.action === 'games') {
      const pageGames = GAMES.slice(parsed.page * 25, parsed.page * 25 + 25).map(game => game.id);
      const selected = interaction.data?.values ?? [];
      if (selected.some(id => !pageGames.includes(id))) throw new UserError('목록에 없는 게임입니다. 다시 선택해 주세요.');
      data.gameIds = [...new Set([...data.gameIds.filter(id => !pageGames.includes(id)), ...selected])];
    } else if (parsed.action === 'roles') {
      return draftPanel(draft, parsed.page, '모집 내용 입력에서 역할 이름을 적어 주세요.');
    } else if (parsed.action === 'submit' || parsed.action === 'submitRoles') {
      if (interaction.type !== 5) throw new UserError('올바르지 않은 상세 입력입니다.');
      const values = modalFields(interaction.data?.components);
      data.start = (values.start ?? '').trim(); data.end = (values.end ?? '').trim();
      data.maximum = (values.maximum ?? '').trim(); data.modes = values.modes ?? ''; data.customGames = values.customGames ?? '';
      if (values.gameText !== undefined) {
        data.customGames = values.gameText;
        data.gameIds = [];
        data.modes = '';
        data.timeText = values.timeText ?? '';
      }
      if (parsed.action === 'submitRoles') {
        const select = interaction.data?.components?.map(label => label.component ?? label).find(field => field.custom_id === 'roleIds');
        const ids = [...new Set(select?.values ?? [])];
        const available = ids.length ? gameRoles(await this.discord.roles(scope.guildId), scope.guildId) : [];
        data.roles = available.filter(role => ids.includes(role.id));
        data.roleText = data.roles.map(role => role.name).join(', ');
        data.roleError = data.roles.length === ids.length ? '' : '역할 목록이 변경됐습니다. 다시 선택해 주세요.';
      } else if (values.gameText !== undefined) {
        data.roleText = values.roleText ?? data.roles.map(role => role.name).join(', ');
        data.roles = [];
        data.roleError = '';
        const names = [...new Set(data.roleText.split(/[,\n]/).map(name => name.trim().replace(/^@/, '')).filter(Boolean))];
        if (names.length > 25) data.roleError = '역할은 최대 25개까지 입력할 수 있습니다.';
        else if (names.length) {
          const roles = await this.discord.roles(scope.guildId);
          for (const name of names) {
            const matches = roles.filter(role => (role.name === name || shortRoleName(role.name) === name) && !role.managed && role.id !== scope.guildId);
            if (matches.length !== 1) {
              data.roleError = matches.length === 0 ? `이 서버에서 일반 역할 ‘${name}’을 찾을 수 없습니다. 서버 역할 이름을 확인해 주세요.`
                : `‘${name}’ 이름의 역할이 여러 개입니다. 서버에서 구분되는 이름을 사용해 주세요.`;
              break;
            }
            const { id, mentionable } = matches[0]!;
            data.roles.push({ id, name: matches[0]!.name, mentionable });
          }
        }
      }
      // 검증 실패한 입력도 보존해 다음 Modal에서 바로 수정할 수 있게 한다.
    } else if (parsed.action === 'publish') {
      validateDraft(data);
      if (draft.edit_id) { await this.repo.editDraft(draft,data,scope); await this.sync.run(draft.edit_id); return privateText('기존 모집글을 수정했습니다.'); }
      const recruitment = await this.repo.publishDraft(draft, data);
      await this.sync.run(recruitment.id);
      const latest = await this.repo.recruitment(recruitment.id);
      return this.publishedPanel(latest?.message_id ?? null, scope, latest?.status === 'publish_failed');
    } else throw new UserError('지원하지 않는 입력입니다.');
    if (draft.edit_id && interaction.type === 5) {
      await this.repo.editDraft(draft,data,scope);
      await this.sync.run(draft.edit_id);
      return editSaved;
    }
    draft = await this.repo.saveDraft(draft, data);
    return draftPanel(draft, parsed.page);
  }
  private publishedPanel(messageId: string | null, scope: Scope, failed: boolean) {
    return privateText(messageId ? `모집을 게시했습니다.\nhttps://discord.com/channels/${scope.guildId}/${scope.channelId}/${messageId}`
      : failed ? '모집 게시를 완료하지 못했거나 결과를 확인할 수 없습니다. 운영자가 채널과 게시 작업 오류를 확인해야 합니다.'
        : '모집 게시를 접수했습니다. Discord 연결을 재시도하고 있으며, 이 패널에서는 중복 게시하지 않습니다.');
  }
}

export function errorResponse(message: string) { return { type: 4, data: { ...privateText(message), flags: 64, allowed_mentions: NO_MENTIONS } }; }
