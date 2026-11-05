import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { Repository } from '../src/database/repository';
import { emptyDraft } from '../src/domain';
import { Discord, type HttpFetch } from '../src/services/discord';
import type { DraftData, MessagePayload, Scope } from '../src/types';

export const scope: Scope = { guildId: '100', channelId: '200', userId: '300' };
export async function database() {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-11-05', d1Databases: ['DB'] }));
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const sql = await readFile(new NodeURL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  // D1 exec는 줄 단위로 파싱하므로 trigger 전체를 포함한 SQL을 한 줄로 보낸다.
  await db.exec(sql.split('\n').filter(line => !line.trim().startsWith('--')).join(' '));
  await db.exec(await readFile(new NodeURL('../migrations/0002_time_label.sql', import.meta.url), 'utf8'));
  await db.exec((await readFile(new NodeURL('../migrations/0003_management.sql', import.meta.url), 'utf8')).split('\n').filter(line => !line.trim().startsWith('--')).join(' '));
  await db.exec((await readFile(new NodeURL('../migrations/0004_start_reminders.sql', import.meta.url), 'utf8')).split('\n').join(' '));
  return { mf, repo: new Repository(db), db };
}
export function validData(overrides: Partial<DraftData> = {}): DraftData {
  const now = Date.now();
  const minute = new Date(now + 9 * 3600000).toISOString().slice(11, 16);
  const end = new Date(now + 9 * 3600000 + 3 * 3600000).toISOString().slice(11, 16);
  return { ...emptyDraft(now), roles: [{ id: '400', name: 'FPS', mentionable: true }], gameIds: ['apex'], start: minute, end, maximum: '4', ...overrides };
}
let nextMessage = 500;
export class FakeDiscord {
  messages = new Map<string, MessagePayload>();
  requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  nextStatus = 0;
  failAfterCreate = false;
  roleList = [{ id: '400', name: 'FPS', mentionable: true }, { id: '401', name: '스팀', mentionable: true }];
  nonces = new Map<string, string>();
  fetch: HttpFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const method = init?.method ?? 'GET';
    this.requests.push({ method, path, body });
    if (this.nextStatus) {
      const status = this.nextStatus; this.nextStatus = 0;
      return Response.json({ retry_after: 1 }, { status });
    }
    if (path.endsWith('/roles')) return Response.json(this.roleList);
    if (method === 'POST' && path.endsWith('/messages')) {
      const nonce = body.nonce as string;
      const id = this.nonces.get(nonce) ?? String(nextMessage++);
      this.nonces.set(nonce, id);
      if (!this.messages.has(id)) this.messages.set(id, body as MessagePayload);
      if (this.failAfterCreate) { this.failAfterCreate = false; throw new Error('simulated timeout'); }
      return Response.json({ id });
    }
    if (method === 'PATCH' && path.includes('/channels/')) {
      this.messages.set(path.split('/').at(-1)!, body as MessagePayload);
      return Response.json({ id: path.split('/').at(-1) });
    }
    return Response.json({ id: '999' });
  };
  client() { return new Discord('test-token', this.fetch); }
}
