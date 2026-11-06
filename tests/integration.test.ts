import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftPanel } from '../src/components';
import { Interactions } from '../src/interactions';
import { MessageSync } from '../src/services/sync';
import { database, FakeDiscord, scope, validData } from './helpers';
import type { DraftData, Interaction } from '../src/types';

let store: Awaited<ReturnType<typeof database>>;
let sequence = 1000;
const unique = () => String(sequence++);
beforeAll(async () => { store = await database(); });
afterAll(async () => { await store?.mf.dispose(); });
async function published(overrides: Partial<DraftData> = {}) {
  const fake = new FakeDiscord();
  const draft = await store.repo.createDraft(unique(), scope);
  const data = validData(overrides);
  const saved = await store.repo.saveDraft(draft, data);
  const r = await store.repo.publishDraft(saved, data);
  const sync = new MessageSync(store.repo, fake.client());
  await sync.run(r.id);
  const current = (await store.repo.recruitment(r.id))!;
  return { r: current, fake, sync };
}
describe('실제 로컬 D1 통합', () => {
  it('작성자 자동 참가와 최초 역할 단일 멘션', async () => {
    const { r, fake } = await published({ roles: [{ id: '400', name: 'FPS', mentionable: true }] });
    expect(r.member_count).toBe(1);
    expect(r.status).toBe('open');
    expect(fake.requests.find(q => q.method === 'POST')!.body.allowed_mentions).toMatchObject({ roles: ['400'], parse: [] });
    expect(r.message_id).toBeTruthy();
  });
  it('참가 → 중복 참가 → 취소 → 재참가 및 중복 interaction 재생', async () => {
    const { r, sync, fake } = await published();
    const user = { ...scope, userId: '301' };
    const event = unique();
    expect(await store.repo.act(event, r.id, user, r.message_id!, 'join')).toBe('joined');
    expect(await store.repo.act(unique(), r.id, user, r.message_id!, 'join')).toBe('already_joined');
    expect(await store.repo.act(unique(), r.id, user, r.message_id!, 'leave')).toBe('left');
    expect(await store.repo.act(event, r.id, user, r.message_id!, 'join')).toBe('joined');
    expect((await store.repo.recruitment(r.id))!.member_count).toBe(1);
    expect(await store.repo.act(unique(), r.id, user, r.message_id!, 'join')).toBe('joined');
    await sync.run(r.id);
    expect(fake.messages.get(r.message_id!)!.content).toContain('[2/4]');
    expect(fake.requests.filter(q => q.method === 'PATCH').every(q => (q.body.allowed_mentions as { roles: string[] }).roles.length === 0)).toBe(true);
  });
  it('동시 20명 참가에도 정원 4명을 초과하지 않음', async () => {
    const { r, sync, fake } = await published();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.repo.act(unique(), r.id, { ...scope, userId: String(700 + i) }, r.message_id!, 'join')));
    expect(results.filter(result => result === 'joined')).toHaveLength(3);
    expect(results.filter(result => result === 'waiting')).toHaveLength(17);
    expect((await store.repo.recruitment(r.id))!.member_count).toBe(4);
    await sync.run(r.id);
    expect(fake.messages.get(r.message_id!)!.components[0]!.components![0]!.disabled).toBe(false);
    const member = await store.db.prepare('SELECT user_id FROM participants WHERE recruitment_id=? AND user_id!=? LIMIT 1').bind(r.id, scope.userId).first<{ user_id: string }>();
    await store.repo.act(unique(), r.id, { ...scope, userId: member!.user_id }, r.message_id!, 'leave');
    await sync.run(r.id);
    expect(fake.messages.get(r.message_id!)!.components[0]!.components![0]!.disabled).toBe(false);
  });
  it('참가자 목록은 모집자 우선이며 참가·탈퇴와 마감 상태를 반영한다', async () => {
    const { r, fake } = await published({ maximum: '2' });
    const handler = new Interactions(store.repo, fake.client());
    const click: Interaction = { id: unique(), application_id: '999', token: 'token', type: 3,
      guild_id: scope.guildId, channel_id: scope.channelId, member: { user: { id: '301' } },
      message: { id: r.message_id! }, data: { custom_id: `r:${r.id}:members` } };
    const guest = { ...scope, userId: '301' };
    await store.repo.act(unique(), r.id, guest, r.message_id!, 'join');
    const full = await handler.handle(click);
    expect(full.content.split('\n').slice(1)).toEqual([`<@${scope.userId}> (모집자)`, '<@301>', '', '대기자 목록 · 0명']);
    expect(full.allowed_mentions.users).toEqual([]);
    await store.repo.act(unique(), r.id, guest, r.message_id!, 'leave');
    expect((await handler.handle(click)).content).not.toContain('<@301>');
    await store.repo.act(unique(), r.id, scope, r.message_id!, 'cancel');
    expect((await handler.handle(click)).content).toContain('(모집자)');
    await expect(handler.handle({ ...click, channel_id: 'wrong' })).rejects.toThrow('사용할 수 없는 모집');
  });
  it('같은 사용자 동시 참가 및 같은 interaction은 한 번만 반영', async () => {
    const { r } = await published();
    const id = unique();
    await Promise.all(Array.from({ length: 10 }, () => store.repo.act(id, r.id, { ...scope, userId: '305' }, r.message_id!, 'join')));
    expect((await store.repo.recruitment(r.id))!.member_count).toBe(2);
  });
  it('정원 1명, DB 직접 삽입도 초과를 차단', async () => {
    const { r, fake } = await published({ maximum: '1' });
    expect(fake.messages.get(r.message_id!)!.components[0]!.components![0]!.disabled).toBe(false);
    await expect(store.db.prepare('INSERT INTO participants VALUES(?,?,?,?)').bind(unique(), r.id, '999', Date.now()).run()).rejects.toThrow('participant_guard');
  });
  it('작성자 참가 고정, 타인 취소 거부, 작성자 전체 취소', async () => {
    const { r, sync, fake } = await published();
    expect(await store.repo.act(unique(), r.id, scope, r.message_id!, 'leave')).toBe('owner_fixed');
    expect(await store.repo.act(unique(), r.id, { ...scope, userId: '301' }, r.message_id!, 'cancel')).toBe('not_owner');
    expect(await store.repo.act(unique(), r.id, scope, r.message_id!, 'cancel')).toBe('cancelled');
    await sync.run(r.id);
    const body = fake.messages.get(r.message_id!)!;
    expect(body.components[0]!.components![3]!.disabled).toBe(true);
    expect(body.content).toMatch(/^\[취소됨\]/);
    expect(body.components[0]!.components!.slice(0, 3).every(button => button.disabled)).toBe(true);
    expect(await store.repo.act(unique(), r.id, { ...scope, userId: '301' }, r.message_id!, 'join')).toBe('closed');
  });
  it('다른 서버/채널/메시지의 조작 거부', async () => {
    const { r } = await published();
    for (const wrong of [{ ...scope, guildId: '101' }, { ...scope, channelId: '201' }]) {
      expect(await store.repo.act(unique(), r.id, wrong, r.message_id!, 'join')).toBe('unavailable');
    }
    expect(await store.repo.act(unique(), r.id, scope, 'wrong', 'join')).toBe('unavailable');
  });
  it('종료 이후 참가 거부 및 버튼 마감', async () => {
    const { r, sync, fake } = await published();
    await store.db.prepare('UPDATE recruitments SET starts_at=?,ends_at=? WHERE id=?').bind(Date.now() - 7200000, Date.now() - 3600000, r.id).run();
    expect(await store.repo.act(unique(), r.id, { ...scope, userId: '301' }, r.message_id!, 'join')).toBe('closed');
    await store.repo.maintenance();
    await sync.run(r.id);
    expect(fake.messages.get(r.message_id!)!.content).toMatch(/^\[종료됨\]/);
  });
  it('draft 소유자, 만료, 오래된 버전 및 동시 게시 방어', async () => {
    const draft = await store.repo.createDraft(unique(), scope);
    await expect(store.repo.draft(draft.id, { ...scope, userId: '301' })).rejects.toThrow('패널');
    await expect(store.repo.draft(draft.id, scope, Date.now() + 1000000)).rejects.toThrow('만료');
    const saved = await store.repo.saveDraft(draft, validData());
    await expect(store.repo.saveDraft(draft, validData())).rejects.toThrow('변경');
    const results = await Promise.allSettled([store.repo.publishDraft(saved, validData()), store.repo.publishDraft(saved, validData())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.repo.recruitment(draft.id))!.member_count).toBe(1);
  });
  it('API 500 이후 outbox 재시도로 DB 인원 복구', async () => {
    const { r, sync, fake } = await published();
    await store.repo.act(unique(), r.id, { ...scope, userId: '301' }, r.message_id!, 'join');
    fake.nextStatus = 500;
    await sync.run(r.id);
    expect((await store.repo.recruitment(r.id))!.member_count).toBe(2);
    expect(fake.messages.get(r.message_id!)!.content).toContain('[1/4]');
    expect(await store.db.prepare('SELECT * FROM message_jobs WHERE recruitment_id=?').bind(r.id).first()).toBeTruthy();
    await store.db.prepare('UPDATE message_jobs SET next_attempt_at=0 WHERE recruitment_id=?').bind(r.id).run();
    await sync.run(r.id);
    expect(fake.messages.get(r.message_id!)!.content).toContain('[2/4]');
  });
  it('API 403은 영구 오류로 기록하고 DB 결과 유지', async () => {
    const { r, sync, fake } = await published();
    await store.repo.act(unique(), r.id, { ...scope, userId: '301' }, r.message_id!, 'join');
    fake.nextStatus = 403;
    await sync.run(r.id);
    expect(await store.db.prepare('SELECT blocked,last_error_code FROM message_jobs WHERE recruitment_id=?').bind(r.id).first()).toEqual({ blocked: 1, last_error_code: 'discord_403' });
    expect((await store.repo.recruitment(r.id))!.member_count).toBe(2);
  });
  it('API 429의 재시도 시간 준수', async () => {
    const { r, sync, fake } = await published();
    await store.repo.act(unique(), r.id, { ...scope, userId: '301' }, r.message_id!, 'join');
    fake.nextStatus = 429;
    const before = Date.now();
    await sync.run(r.id);
    const job = await store.db.prepare('SELECT next_attempt_at FROM message_jobs WHERE recruitment_id=?').bind(r.id).first<{ next_attempt_at: number }>();
    expect(job!.next_attempt_at).toBeGreaterThanOrEqual(before + 1000);
    const calls = fake.requests.length;
    await sync.run(r.id);
    expect(fake.requests.length).toBe(calls);
  });
  it('갱신 도중 새 참가가 오면 최신 버전을 다시 반영', async () => {
    const { r, fake } = await published();
    await store.repo.act(unique(), r.id, { ...scope, userId: '301' }, r.message_id!, 'join');
    const originalFetch = fake.fetch;
    let updated = false;
    fake.fetch = async (url, init) => {
      if (!updated && init?.method === 'PATCH') {
        updated = true;
        await store.repo.act(unique(), r.id, { ...scope, userId: '302' }, r.message_id!, 'join');
      }
      return originalFetch(url, init);
    };
    await new MessageSync(store.repo, fake.client()).run(r.id);
    expect(fake.messages.get(r.message_id!)!.content).toContain('[3/4]');
    const latest = (await store.repo.recruitment(r.id))!;
    expect(latest.synced_version).toBe(latest.version);
  });
  it('동기화 작업이 없어도 주기적 재동기화로 표시 복구', async () => {
    const { r, sync, fake } = await published();
    fake.messages.get(r.message_id!)!.content = '오래된 표시';
    await store.db.prepare('UPDATE recruitments SET next_reconcile_at=0 WHERE id=?').bind(r.id).run();
    await store.repo.maintenance();
    await sync.run(r.id);
    expect(fake.messages.get(r.message_id!)!.content).toContain('[1/4]');
  });
  it('D1 batch 중 실패하면 receipt까지 전체 롤백', async () => {
    const { r } = await published({ maximum: '1' });
    const receiptId = unique();
    await expect(store.db.batch([
      store.db.prepare('INSERT INTO interaction_receipts VALUES(?,?,?,?)').bind(receiptId, 'claim', 'joined', Date.now()),
      store.db.prepare('INSERT INTO participants VALUES(?,?,?,?)').bind(unique(), r.id, '999', Date.now()),
    ])).rejects.toThrow('participant_guard');
    expect(await store.db.prepare('SELECT * FROM interaction_receipts WHERE interaction_id=?').bind(receiptId).first()).toBeNull();
  });
  it('최초 게시 응답 유실 후 nonce로 중복 메시지 방지', async () => {
    const fake = new FakeDiscord(); fake.failAfterCreate = true;
    const draft = await store.repo.createDraft(unique(), scope);
    const r = await store.repo.publishDraft(draft, validData());
    const sync = new MessageSync(store.repo, fake.client());
    await sync.run(r.id);
    await store.db.prepare('UPDATE message_jobs SET next_attempt_at=0 WHERE recruitment_id=?').bind(r.id).run();
    await sync.run(r.id);
    expect(fake.messages.size).toBe(1);
    expect((await store.repo.recruitment(r.id))!.message_id).toBeTruthy();
  });
  it('오래된 최초 게시 불확실 상태는 자동 재게시 금지', async () => {
    const fake = new FakeDiscord(); fake.failAfterCreate = true;
    const draft = await store.repo.createDraft(unique(), scope);
    const r = await store.repo.publishDraft(draft, validData());
    const sync = new MessageSync(store.repo, fake.client());
    await sync.run(r.id);
    await store.db.prepare('UPDATE message_jobs SET next_attempt_at=0,first_attempt_at=? WHERE recruitment_id=?').bind(Date.now() - 121000, r.id).run();
    const calls = fake.requests.length;
    await sync.run(r.id);
    expect(fake.requests.length).toBe(calls);
    expect((await store.repo.recruitment(r.id))!.status).toBe('publish_failed');
    expect(await store.db.prepare('SELECT last_error_code FROM message_jobs WHERE recruitment_id=?').bind(r.id).first()).toEqual({ last_error_code: 'publish_ambiguous' });
  });
  it('선택 이후 삭제된 역할은 게시 중단', async () => {
    const fake = new FakeDiscord(); fake.roleList = [];
    const draft = await store.repo.createDraft(unique(), scope);
    const r = await store.repo.publishDraft(draft, validData({ roles: [{ id: '400', name: 'FPS', mentionable: true }] }));
    await new MessageSync(store.repo, fake.client()).run(r.id);
    expect((await store.repo.recruitment(r.id))!.status).toBe('publish_failed');
    expect(fake.messages.size).toBe(0);
  });
  it('역할 없는 초안은 직접 게시 요청도 거부한다', async () => {
    const draft = await store.repo.createDraft(unique(), scope);
    const data = validData({ roles: [] });
    const saved = await store.repo.saveDraft(draft, data);
    await expect(store.repo.publishDraft(saved, data)).rejects.toThrow('알릴 역할');
    expect(await store.repo.recruitment(draft.id)).toBeNull();
  });
  it('개인 패널 → 수기 게임/서버 역할 → Modal → 확인 활성화 → 게시 흐름', async () => {
    const fake = new FakeDiscord();
    fake.roleList[0]!.mentionable = false;
    fake.roleList[0]!.name = 'FPS(모든장르)';
    fake.roleList.push({ id: '402', name: '관리자', mentionable: true });
    const handler = new Interactions(store.repo, fake.client());
    const draftId = unique();
    const base: Interaction = { id: draftId, application_id: '999', token: 'token', type: 2, guild_id: scope.guildId, channel_id: scope.channelId, member: { user: { id: scope.userId } }, data: { name: '모집' } };
    let panel = await handler.handle(base);
    expect(panel.components[0]!.components![1]!.disabled).toBe(true);
    expect(panel.components.flatMap(row => row.components ?? []).some(c => c.type === 3)).toBe(false);
    const modal = await handler.openModal({ ...base, type: 3, data: { custom_id: `d:${draftId}:0:details:0` } });
    expect(modal.type).toBe(9);
    const select = modal.data.components.find(label => label.component?.custom_id === 'roleIds')!.component!;
    expect(select).toMatchObject({ required: true, min_values: 1 });
    expect(select.options).toEqual([expect.objectContaining({ label: 'FPS(모든장르)', value: '400' }), expect.objectContaining({ value: '401' })]);
    const fields = { gameText: '증바람', timeText: '지금', maximum: '5' };
    panel = await handler.handle({ ...base, id: unique(), type: 5, data: { custom_id: modal.data.custom_id, components: [{ type: 18, component: { type: 3, custom_id: 'roleIds', values: ['400', '401'] } }, ...Object.entries(fields).map(([custom_id,value]) => ({ type: 18, component: { type: 4, custom_id, value } }))] } });
    expect(panel.components[0]!.components![1]!.disabled).toBe(false);
    const result = await handler.handle({ ...base, id: unique(), type: 3, data: { custom_id: `d:${draftId}:1:publish:0` } });
    expect(result.content).toContain('모집을 게시했습니다');
    const r = (await store.repo.recruitment(draftId))!;
    expect(fake.messages.get(r.message_id!)!.content).toBe(`<@${scope.userId}>님이 모집 중에 있습니다.\n증바람 / 지금 / [1/5] / <@&400>, <@&401>`);
    const click = { ...base, type: 3, member: { user: { id: '302' } }, message: { id: r.message_id! } };
    for (const [action, count] of [['join', 2], ['leave', 1]]) {
      await handler.handle({ ...click, id: unique(), data: { custom_id: `r:${r.id}:${action}` } });
      expect(fake.messages.get(r.message_id!)!.content).toBe(`<@${scope.userId}>님이 모집 중에 있습니다.\n증바람 / 지금 / [${count}/5] / <@&400>, <@&401>`);
    }
    expect(draftPanel(await store.repo.draft(draftId, scope)).components).toEqual([]);
  });
});

it('게시와 확정 참가 시 스레드 멤버로 추가하고 대기자는 추가하지 않는다',async()=>{
  const {r,sync,fake}=await published({maximum:'2'});
  for(const userId of ['301','302']) {
    await store.repo.act(unique(),r.id,{...scope,userId},r.message_id!,'join');
    await sync.run(r.id);
  }
  expect(fake.requests.filter(q=>q.method==='PUT').map(q=>q.path.split('/').at(-1))).toEqual([scope.userId,'301']);
});
