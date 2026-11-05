export interface Env {
  DB: D1Database;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
}

export interface Role { managed?: boolean; id: string; name: string; mentionable: boolean }
export interface Component {
  type: number;
  custom_id?: string;
  value?: string;
  values?: string[];
  components?: Component[];
  component?: Component;
  [key: string]: unknown;
}
export interface Interaction {
  id: string;
  application_id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string }; permissions?: string };
  message?: { id: string; flags?: number };
  data?: {
    name?: string; custom_id?: string; component_type?: number;
    values?: string[]; components?: Component[];
    resolved?: { roles?: Record<string, Role> };
  };
}
export interface Scope { guildId: string; channelId: string; userId: string }
export interface Game { name: string; mode?: string }
export interface DraftData {
  roleText?: string;
  roleError?: string;
  timeText?: string;
  gameIds: string[];
  roles: Role[];
  start: string;
  end: string;
  maximum: string;
  modes: string;
  customGames: string;
  date: string;
}
export interface Draft {
  edit_id?: string | null;
  id: string; guild_id: string; channel_id: string; owner_id: string;
  payload: string; version: number; expires_at: number; consumed_by: string | null;
}
export interface Recruitment {
  completed?: number; creator_id?: string; changes_json?: string;
  time_label?: string | null;
  id: string; guild_id: string; channel_id: string; message_id: string | null;
  owner_id: string; games_json: string; role_ids_json: string;
  starts_at: number; ends_at: number; timezone: string; max_members: number;
  status: 'publishing' | 'open' | 'cancelled' | 'ended' | 'publish_failed';
  version: number; synced_version: number; created_at: number; updated_at: number;
  member_count: number;
}
export interface MessagePayload {
  content: string;
  components: Component[];
  allowed_mentions: { parse: string[]; roles?: string[]; users?: string[]; replied_user: boolean };
  flags?: number;
}
export class UserError extends Error {}
