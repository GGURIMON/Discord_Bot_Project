import { afterAll, beforeAll, expect, it } from 'vitest';
import { database, FakeDiscord, scope, validData } from './helpers';
import { MessageSync } from '../src/services/sync';
import { manage } from '../src/database/management';
import { Interactions } from '../src/interactions';
let store: Awaited<ReturnType<typeof database>>;
let n=90000;
const event=()=>String(n++);
beforeAll(async()=>{store=await database();});
afterAll(async()=>{await store?.mf.dispose();});
async function setup(maximum='2') {
  const d=await store.repo.createDraft(event(),scope);
  const r=await store.repo.publishDraft(d,validData({maximum}));
  const fake=new FakeDiscord();
  await new MessageSync(store.repo,fake.client()).run(r.id);
  const current=(await store.repo.recruitment(r.id))!;
  const act=(userId:string,action:'join'|'leave')=>store.repo.act(event(),r.id,{...scope,userId},current.message_id!,action);
  const admin=(action:string,target='',userId=scope.userId)=>manage(store.repo,event(),r.id,{...scope,userId},current.message_id!,action,target);
  return {r:current,fake,act,admin};
}
it('대기열 우회 차단, 취소 후 마지막 재신청, 선택 전환과 최초 순서 복원',async()=>{
  const {r,act,admin}=await setup();
  expect(await act('301','join')).toBe('joined');
  expect(await act('302','join')).toBe('waiting');
  expect(await act('303','join')).toBe('waiting');
  expect(await act('302','join')).toBe('already_waiting');
  await act('301','leave');
  expect(await act('304','join')).toBe('waiting');
  expect(await admin('promote','303')).toBe('managed');
  expect(await admin('restore','303')).toBe('managed');
  let list=await store.db.prepare('SELECT user_id FROM waiting WHERE recruitment_id=? AND promoted=0 ORDER BY sequence').bind(r.id).all();
  expect(list.results.map(x=>x.user_id)).toEqual(['302','303','304']);
  expect(await act('302','leave')).toBe('unwaited');
  await act('302','join');
  list=await store.db.prepare('SELECT user_id FROM waiting WHERE recruitment_id=? ORDER BY sequence').bind(r.id).all();
  expect(list.results.map(x=>x.user_id)).toEqual(['303','304','302']);
  await admin('promote','303'); await act('303','leave');
  expect(await admin('restore','303')).toBe('stale');
  expect(await admin('restore',scope.userId)).toBe('stale');
});
it('동시 참가 전환 정원과 다른 서버/사용자 권한 방어',async()=>{
  const {r,act,admin}=await setup('1');
  await act('301','join'); await act('302','join');
  await store.db.prepare('UPDATE recruitments SET max_members=2 WHERE id=?').bind(r.id).run();
  const results=await Promise.all([admin('promote','301'),admin('promote','302')]);
  expect(results.filter(x=>x==='managed')).toHaveLength(1);
  expect((await store.repo.recruitment(r.id))!.member_count).toBe(2);
  expect(await admin('complete','','301')).toBe('not_owner');
  expect(await manage(store.repo,event(),r.id,{...scope,guildId:'wrong'},r.message_id!,'complete')).toBe('unavailable');
});
it('위임 수락, 재위임, 기존 모집자 탈퇴와 전환 내역 복원 권한 승계',async()=>{
  const {r,act,admin}=await setup('2');
  await act('301','join'); await act('302','join'); await act('301','leave'); await admin('promote','302');
  const offer=event();
  expect(await manage(store.repo,offer,r.id,scope,r.message_id!,'offer','302')).toBe('managed');
  expect(await admin('accept',offer,'301')).toBe('stale');
  expect(await admin('accept',offer,'302')).toBe('managed');
  expect(await act(scope.userId,'leave')).toBe('left');
  expect(await admin('restore','302','302')).toBe('stale');
  await act('303','join');
  const next=event(); await manage(store.repo,next,r.id,{...scope,userId:'302'},r.message_id!,'offer','303');
  await admin('accept',next,'303');
  expect(await admin('restore','302','303')).toBe('managed');
});
it('거절 및 대상 탈퇴 후 수락 금지',async()=>{
  const {r,act,admin}=await setup(); await act('301','join');
  const offer=event(); await manage(store.repo,offer,r.id,scope,r.message_id!,'offer','301');
  expect(await admin('reject',offer,'301')).toBe('managed');
  expect(await admin('accept',offer,'301')).toBe('stale');
  const offer2=event(); await manage(store.repo,offer2,r.id,scope,r.message_id!,'offer','301');
  await act('301','leave'); expect(await admin('accept',offer2,'301')).toBe('stale');
  expect((await store.repo.recruitment(r.id))!.owner_id).toBe(scope.userId);
});
it('완료 후 신규 참가 차단, 명단 조회 및 복사는 유지하고 서버 격리',async()=>{
  const {r,act,admin,fake}=await setup('1'); await act('301','join');
  await admin('complete'); expect(await act('302','join')).toBe('closed');
  const handler=new Interactions(store.repo,fake.client());
  const base={id:event(),application_id:'999',token:'x',type:3,guild_id:scope.guildId,channel_id:scope.channelId,member:{user:{id:scope.userId}},message:{id:r.message_id!}};
  expect((await handler.handle({...base,data:{custom_id:`r:${r.id}:members`}})).content).toContain('1. <@301>');
  const copy=await handler.handle({...base,data:{custom_id:'copy',values:[r.id]}});
  expect(copy.content).toContain(r.time_label);
  expect(copy.content).toContain('<@&400>');
  expect(copy.content).toContain('[1/1]');
  expect(copy.components[0]?.components?.[1]?.disabled).toBe(false);
  await expect(handler.handle({...base,guild_id:'wrong',data:{custom_id:'copy',values:[r.id]}})).rejects.toThrow();
});
it('수정은 기존 글 유지, 정원 감소/권한 변경 방어 및 재멘션 차단',async()=>{
  const {r,act,fake}=await setup(); await act('301','join');
  const handler=new Interactions(store.repo,fake.client());
  const base={id:event(),application_id:'999',token:'x',type:3,guild_id:scope.guildId,channel_id:scope.channelId,member:{user:{id:scope.userId}},message:{id:r.message_id!},data:{custom_id:`m:${r.id}:edit:${r.message_id}`}};
  expect((await handler.openModal(base)).type).toBe(9);
  let d=await store.repo.draft(base.id,scope);
  const data=validData({maximum:'1'});
  await expect(store.repo.editDraft(d,data,scope)).rejects.toThrow();
  const fields = {gameText:'테스트(일반)', timeText:'지금', maximum:'3'};
  const saved = await handler.handle({...base,type:5,data:{custom_id:`d:${d.id}:${d.version}:submitRoles:0`,components:[
    {type:18,component:{type:3,custom_id:'roleIds',values:['400']}},
    ...Object.entries(fields).map(([custom_id,value])=>({type:18,component:{type:4,custom_id,value}}))
  ]}});
  expect(saved.components).toEqual([]);
  expect((await store.repo.recruitment(r.id))!.max_members).toBe(3);
  await new MessageSync(store.repo,fake.client()).run(r.id);
  expect((await store.repo.recruitment(r.id))!.message_id).toBe(r.message_id);
  expect((await store.repo.recruitment(r.id))!.member_count).toBe(2);
  expect(fake.messages.get(r.message_id!)!.allowed_mentions.roles).toEqual([]);
  expect(fake.messages.get(r.message_id!)!.content).not.toContain('변경 내역');
});
