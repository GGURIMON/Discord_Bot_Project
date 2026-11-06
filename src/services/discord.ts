import { NO_MENTIONS } from '../components';
import type { Interaction, MessagePayload, Role } from '../types';

export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;
export class DiscordError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super(`Discord API ${status}`); }
}
export class Discord {
  constructor(private token: string, private http: HttpFetch = (url, init) => fetch(url, init)) {}
  async request<T>(method: string, path: string, body?: unknown, botAuth = true): Promise<T> {
    let response: Response;
    try {
      response = await this.http(`https://discord.com/api/v10${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(botAuth ? { Authorization: `Bot ${this.token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(6000),
      });
    } catch { throw new DiscordError(0); }
    if (!response.ok) {
      let retryAfter = 0;
      if (response.status === 429) {
        const data = await response.json().catch(() => ({})) as { retry_after?: number };
        retryAfter = Math.ceil((Number(data.retry_after) || 1) * 1000);
      }
      // 응답 본문이나 URL에는 비밀값이 포함될 수 있으므로 오류에 붙이지 않는다.
      throw new DiscordError(response.status, retryAfter);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  async memberDisplayName(guildId: string, userId: string) {
    const member = await this.request<{nick?:string|null; user:{global_name?:string|null;username:string}}>(
      'GET', `/guilds/${guildId}/members/${userId}`);
    return member.nick || member.user.global_name || member.user.username;
  }
  async notifyTransfer(userId: string, requestId: string, postUrl: string) {
    const dm = await this.request<{id:string}>('POST','/users/@me/channels',{recipient_id:userId});
    return this.create(dm.id, requestId, {
      content: `<@${userId}>님에게 모집자 권한 위임 요청이 도착했습니다. 15분 안에 모집글 설정의 ‘위임 응답’에서 수락하거나 거절해 주세요.`,
      components: [{type:1,components:[{type:2,style:5,label:'모집글 열기',url:postUrl}]}],
      allowed_mentions: {...NO_MENTIONS,users:[userId]},
    });
  }
  roles(guildId: string) { return this.request<Role[]>('GET', `/guilds/${guildId}/roles`); }
  create(channelId: string, id: string, payload: MessagePayload) {
    return this.request<{ id: string }>('POST', `/channels/${channelId}/messages`, { ...payload, nonce: id, enforce_nonce: true });
  }
  edit(channelId: string, messageId: string, payload: MessagePayload) {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { ...payload, allowed_mentions: NO_MENTIONS });
  }
  deleteReply(interaction: Interaction) {
    return this.request('DELETE', `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, undefined, false);
  }
  reply(interaction: Interaction, payload: MessagePayload) {
    return this.request('PATCH', `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, payload, false);
  }
}
