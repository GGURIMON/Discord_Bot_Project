import { Interactions } from '../src/interactions';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { verifySignature } from '../src/security';
import type { Env } from '../src/types';

let pair: CryptoKeyPair;
let publicKey: string;
const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString('hex');
beforeAll(async () => {
  pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  publicKey = hex(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
});
async function signed(raw: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = hex(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(timestamp + raw)));
  return new Request('https://bot.example/interactions', { method: 'POST', body: raw, headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp } });
}
describe('HTTP 서명 및 초기 응답', () => {
  it('정상 서명 PING → PONG', async () => {
    const response = await worker.fetch(await signed(JSON.stringify({ type: 1, application_id: '123' })), { DISCORD_PUBLIC_KEY: publicKey, DISCORD_APPLICATION_ID: '123' } as Env, {} as ExecutionContext);
    expect(await response.json()).toEqual({ type: 1 });
  });
  it('잘못된 서명과 본문 변경은 401', async () => {
    const request = await signed('{}');
    const tampered = new Request(request.url, { method: 'POST', body: '{"changed":true}', headers: request.headers });
    const response = await worker.fetch(tampered, { DISCORD_PUBLIC_KEY: publicKey } as Env, {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(await verifySignature(new Request(request.url), '{}', publicKey)).toBe(false);
  });
  it('오래된 서명 재생 거부', async () => {
    expect(await verifySignature(await signed('{}', '100'), '{}', publicKey)).toBe(false);
  });
  it('다른 애플리케이션 거부', async () => {
    const response = await worker.fetch(await signed(JSON.stringify({ type: 1, application_id: 'wrong' })), { DISCORD_PUBLIC_KEY: publicKey, DISCORD_APPLICATION_ID: '123' } as Env, {} as ExecutionContext);
    expect(response.status).toBe(401);
  });
  it('준비된 개인 패널은 최초 HTTP 응답으로 전달한다', async () => {
    const draft = { id: '900', version: 0, expires_at: Date.now()+900000, payload: JSON.stringify({ gameIds: [], roles: [], customGames: '', modes: '' }) };
    const env = { DISCORD_PUBLIC_KEY: publicKey, DISCORD_APPLICATION_ID: '123', DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => draft }) }) } } as unknown as Env;
    const request = await signed(JSON.stringify({ type: 2, id: '900', application_id: '123', token: 'token', guild_id: '100', channel_id: '200', member: { user: { id: '300' } }, data: { name: '모집' } }));
    const reply = await worker.fetch(request, env, {} as ExecutionContext);
    expect(await reply.json()).toMatchObject({ type: 4, data: { flags: 64, components: expect.any(Array) } });
  });
  it('DB가 지연되어도 일반 명령어는 즉시 defer', async () => {
    const never = new Promise(() => {});
    const env = { DISCORD_PUBLIC_KEY: publicKey, DISCORD_APPLICATION_ID: '123', DB: { prepare: () => ({ bind: () => ({ run: () => never }) }) } } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (task: Promise<unknown>) => { pending.push(task); } } as ExecutionContext;
    const start = performance.now();
    const response = await worker.fetch(await signed(JSON.stringify({ type: 2, id: '900', application_id: '123', token: 'token', guild_id: '100', channel_id: '200', member: { user: { id: '300' } }, data: { name: '모집' } })), env, ctx);
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(performance.now() - start).toBeLessThan(2300);
    expect(pending).toHaveLength(1);
  });
});

it.each([
  ['recent', 64, 6], ['copy', 64, 6], ['m:1:chooseOffer:2', 64, 6],
  ['d:1:2:discard:0', 64, 6], ['r:1:manage', 0, 5],
])('버튼 %s의 원본 메시지에 맞게 응답한다', async (custom_id, flags, type) => {
  const mock = vi.spyOn(Interactions.prototype, 'process').mockResolvedValue();
  try {
    const body = { type: 3, id: '900', application_id: '123', token: 'x', guild_id: '1', channel_id: '2',
      member: { user: { id: '3' } }, message: { id: '4', flags }, data: { custom_id } };
    const env = { DISCORD_PUBLIC_KEY: publicKey, DISCORD_APPLICATION_ID: '123' } as Env;
    const response = await worker.fetch(await signed(JSON.stringify(body)), env, { waitUntil() {} } as unknown as ExecutionContext);
    expect(await response.json()).toEqual(type === 6 ? { type: 6 } : { type: 5, data: { flags: 64 } });
  } finally { mock.mockRestore(); }
});
it('공개 모집 관리 드롭다운에서 선택한 작업을 원본 메시지에 연결한다', async () => {
  const process = vi.spyOn(Interactions.prototype,'process').mockResolvedValue();
  try {
    const body = {type:3,id:'900',application_id:'123',token:'x',guild_id:'1',channel_id:'2',
      member:{user:{id:'3'}},message:{id:'4',flags:0},data:{custom_id:'r:5:menu',values:['askComplete']}};
    const response = await worker.fetch(await signed(JSON.stringify(body)),
      {DISCORD_PUBLIC_KEY:publicKey,DISCORD_APPLICATION_ID:'123'} as Env,{waitUntil(){}} as unknown as ExecutionContext);
    expect(await response.json()).toEqual({type:5,data:{flags:64}});
    expect(process.mock.calls[0]?.[0].data?.custom_id).toBe('m:5:askComplete:4');
  } finally { process.mockRestore(); }
});
