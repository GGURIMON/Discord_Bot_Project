// 외부 서버 설정을 변경하는 명시적 수동 명령이다. CI에서 자동 실행하지 않는다.
const { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId } = process.env;
if (!appId || !token || !guildId || !/^\d+$/.test(appId) || !/^\d+$/.test(guildId)) {
  console.error('.dev.vars에 DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID를 설정해 주세요.');
  process.exit(1);
}
try {
  // POST는 같은 이름의 명령어만 upsert하며 서버의 다른 명령어를 삭제하지 않는다.
  const response = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '모집', description: '게임 파티 모집을 만들고 참가 인원을 관리합니다.', type: 1 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Discord API ${response.status}`);
  console.log('개발 서버에 /모집 명령어를 등록했습니다.');
} catch (error) {
  console.error(error instanceof Error && /^Discord API \d+$/.test(error.message) ? error.message : '명령어 등록 연결에 실패했습니다.');
  process.exit(1);
}
