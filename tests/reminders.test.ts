import { afterEach,beforeEach,expect,it } from 'vitest';
import { database,scope,validData } from './helpers';
import { Discord, type HttpFetch } from '../src/services/discord';
import { StartReminders } from '../src/services/reminders';
import { validateDraft } from '../src/domain';

let store:Awaited<ReturnType<typeof database>>;
const created=Date.parse('2032-12-31T23:45:00+09:00');
let now:number;
const start=Date.parse('2033-01-01T00:10:00+09:00');
let sequence=0;
const posts = new Map<string,{content:string;allowed_mentions:{users:string[];roles:string[]}}>();
const threads=new Map<string,{id:string;parent_id:string;guild_id:string;type:number}>();
let createCount=0, fail=0, loseThread=false, loseMessage=false;
const json=(data:unknown,status=200)=>Response.json(data,{status});
const http:HttpFetch=async(url,init)=>{
  const path=new URL(url).pathname.replace('/api/v10','');
  const [, ,channel,,message]=path.split('/');
  if (path.includes('/thread-members/')) {
    const user_id=path.split('/').at(-1)!;
    return json({user_id},['300','302','999'].includes(user_id)?200:404);
  }
  if (path.endsWith('/thread-members')) {
    const users=['300','302','999',...Array.from({length:80},(_,i)=>String(1000000000000000000n+BigInt(i)))];
    return json(users.map(user_id=>({user_id})));
  }
  if (init?.method==='GET') return json(threads.get(channel!) ?? {type:0,guild_id:channel==='201'?'101':'100'},
    threads.has(channel!) || ['200','201'].includes(channel!) ? 200 : 404);
  if (path.endsWith('/threads')) {
    createCount++;
    const thread={id:message!,parent_id:channel!,guild_id:channel==='201'?'101':'100',type:11};
    threads.set(message!,thread);
    if(loseThread){loseThread=false;throw Error('lost response');}
    return json(thread);
  }
  if(fail){const status=fail;fail=0;return json({retry_after:1},status);}
  const body=JSON.parse(String(init?.body));
  if (!posts.has(channel!+':'+body.nonce) || !body.enforce_nonce) posts.set(channel!+':'+body.nonce,body);
  if(loseMessage){loseMessage=false;throw Error('lost message response');}
  return json({id:'sent'});
};
const cron=()=>new StartReminders(store.db,new Discord('test',http),()=>now).drain();
async function recruit(timeText='00:10',guild='100',channel='200',owner='300'){
  const id=String(++sequence), s={userId:owner,guildId:guild,channelId:channel};
  const d=await store.repo.createDraft(id,s,created);
  await store.repo.publishDraft(d,validData({timeText,maximum:'2'}),created);
  const message='9'+id;
  await store.db.prepare("UPDATE recruitments SET status='open',message_id=? WHERE id=?").bind(message,id).run();
  return {id,message,s};
}
beforeEach(async()=>{store=await database();now=start-600000;posts.clear();threads.clear();createCount=0;fail=0;loseThread=false;loseMessage=false;});
afterEach(async()=>{await store.mf.dispose();});
it('KST 자정과 새해를 넘어 다음 시작 시각을 UTC로 저장한다',()=>{
  const v=validateDraft(validData({timeText:'00:10 ~ 01:00'}),created);
  expect(v.startsAt).toBe(start);expect(v.endsAt-start).toBe(50*60000);
});
it('두 서버의 원본에 연결하고 발송 시점 명단만 멘션한다',async()=>{
  const a=await recruit(), b=await recruit('00:10','101','201','999');
  const act=(userId:string,action:'join'|'leave')=>store.repo.act(String(++sequence),a.id,{...scope,userId},a.message,action,created+1000);
  await act('301','join');await act('302','join');await act('303','join');await act('301','leave');
  const {manage}=await import('../src/database/management');
  await manage(store.repo,String(++sequence),a.id,scope,a.message,'promote','302',created+2000);
  now--;await cron();expect(createCount).toBe(0);now++;
  await Promise.all([cron(),cron()]);await cron();
  expect(createCount).toBe(2);expect(posts.size).toBe(2);
  expect(posts.get(a.message+':'+a.id+'-0')!.content).toContain('시작 10분 전입니다!\n게임 시작 예정: 00시 10분\n\n<@300> <@302> 게임 시작 준비를 해주세요!');
  expect(posts.get(a.message+':'+a.id+'-0')!.allowed_mentions).toEqual({parse:[],users:['300','302'],roles:[],replied_user:false});
  expect(posts.get(b.message+':'+b.id+'-0')!.allowed_mentions.users).toEqual(['999']);
  now+=86400000;await cron();expect(createCount).toBe(2);
});
it('지금, 10분 미만, 취소, 종료, 시작 이후에는 발송하지 않는다',async()=>{
  await recruit('지금');await recruit('23:50');
  for(const status of ['cancelled','ended']){
    const r=await recruit();await store.db.prepare('UPDATE recruitments SET status=? WHERE id=?').bind(status,r.id).run();
  }
  await cron(); expect(posts.size).toBe(0);
  await recruit();now=start+1;await cron();expect(createCount).toBe(0);
});
it('시각 수정 후 새 일정으로 한 번만 보내며 완료된 모집도 확정 명단에 알린다',async()=>{
  const r=await recruit();
  const change=()=>store.db.prepare('UPDATE recruitments SET starts_at=starts_at+3600000,ends_at=ends_at+3600000,completed=1 WHERE id=?').bind(r.id).run();
  await change();await cron();expect(posts.size).toBe(0);
  now+=3600000;await cron();expect(posts.size).toBe(1);
  await change();now+=3600000;await cron();expect(createCount).toBe(1);
});
it.each([429,503])('메시지 오류 %i 후 재시작해 기존 스레드로 전송한다',async(status)=>{
  await recruit();fail=status;await cron();expect(posts.size).toBe(0);
  now+=60000;await cron();expect(createCount).toBe(1);expect(posts.size).toBe(1);
});
it('스레드 생성 응답 유실 시 원본 ID로 복구한다',async()=>{
  await recruit();loseThread=true;await cron();now+=60000;await cron();
  expect(createCount).toBe(1);expect(posts.size).toBe(1);
});
it('권한 거부를 기록하고 반복 호출을 중단한다',async()=>{
  const r=await recruit();fail=403;await cron();now+=60000;await cron();
  expect(await store.db.prepare('SELECT blocked,last_error FROM start_reminders WHERE recruitment_id=?').bind(r.id).first()).toEqual({blocked:1,last_error:'discord_403'});
  expect(posts.size).toBe(0);
});

it('전송 응답이 유실돼도 재시작 후 같은 nonce로 복구한다',async()=>{
  const r=await recruit();loseMessage=true;await cron();expect(posts.size).toBe(1);
  const first=[...posts.values()][0];
  now+=60000;await cron();
  expect([...posts.values()][0]).toBe(first);
  expect(await store.db.prepare('SELECT sent_at FROM start_reminders WHERE recruitment_id=?').bind(r.id).first('sent_at')).toBe(now);
});
it('확정 명단을 Discord 길이·멘션 한도에 맞춰 분할한다',async()=>{
  const r=await recruit();await store.db.prepare('UPDATE recruitments SET max_members=100 WHERE id=?').bind(r.id).run();
  await store.db.batch(Array.from({length:80},(_,i)=>store.db.prepare('INSERT INTO participants VALUES(?,?,?,?)')
    .bind('p'+i,r.id,String(1000000000000000000n+BigInt(i)),created+1000)));
  await cron();expect(createCount).toBe(1);expect(posts.size).toBe(2);
  const users=[...posts.values()].flatMap(p=>p.allowed_mentions.users);
  expect(users).toHaveLength(81);expect(new Set(users).size).toBe(81);
  expect([...posts.values()].every(p=>p.content.length<=2000)).toBe(true);
});

it('스레드를 나간 확정 참가자와 단순 구독자는 알림에서 제외한다',async()=>{
  const r=await recruit();
  await store.repo.act(String(++sequence),r.id,{...scope,userId:'301'},r.message,'join',created+1000);
  await cron();
  expect([...posts.values()][0]!.allowed_mentions.users).toEqual(['300']);
  expect([...posts.values()][0]!.content).toContain('<@300>');
});

it('종료 시간만 수정하면 처리 대기 중인 예약과 재시도 기록을 그대로 보존한다',async()=>{
  const r=await recruit();
  await store.db.prepare("UPDATE start_reminders SET attempts=1,next_at=due_at+60000,last_error='discord_429' WHERE recruitment_id=?").bind(r.id).run();
  const row=()=>store.db.prepare('SELECT * FROM start_reminders WHERE recruitment_id=?').bind(r.id).first();
  const before=await row();
  await store.db.prepare("UPDATE recruitments SET ends_at=ends_at+60000,time_label='00:10 ~ 01:00' WHERE id=?").bind(r.id).run();
  expect(await row()).toEqual(before);
  now+=60000;await cron();expect(posts.size).toBe(1);
});
it('5분을 넘긴 적체도 시작 전까지 분당 두 모집씩 전송한다',async()=>{
  for(let i=0;i<5;i++)await recruit();
  now=start-4*60000;
  for(const count of [2,4,5]){await cron();expect(posts.size).toBe(count);now+=60000;}
});
it('늦게 429를 받은 경우 시작 전 다음 실행에서 남은 시간을 알린다',async()=>{
  await recruit();now=start-6*60000;fail=429;await cron();now+=2*60000;await cron();
  expect([...posts.values()][0]?.content).toContain('시작 4분 전');
});
it('응답을 잃고 안전한 재전송 시간을 넘기면 시작 전이라도 다시 보내지 않는다',async()=>{
  const r=await recruit();loseMessage=true;await cron();
  now=start-60000;await cron();
  expect(await store.db.prepare('SELECT last_error FROM start_reminders WHERE recruitment_id=?').bind(r.id).first('last_error')).toBe('ambiguous_send');
  expect(posts.size).toBe(1);
});
