// Explicit manual synchronization; never run during deployment/CI.
const { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token } = process.env;
const guilds = [...new Set((process.env.DISCORD_LEGACY_GUILD_IDS ?? process.env.DISCORD_GUILD_ID ?? '').split(',').map(x=>x.trim()).filter(Boolean))];
if (!appId || !token || !/^\d+$/.test(appId) || guilds.some(id=>!/^\d+$/.test(id))) {
  console.error('Application ID, bot token and optional legacy guild IDs must be configured.'); process.exit(1);
}
async function request(path,method='GET',body) {
  const response = await fetch(`https://discord.com/api/v10/applications/${appId}${path}`, {
    method,headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Discord API ${response.status} (${method} ${path})`);
  return response.status===204 ? null : response.json();
}
try {
  await request('/commands','POST',{name:'모집',description:'게임 파티 모집을 만들고 참가 인원을 관리합니다.',type:1,integration_types:[0],contexts:[0]});
  console.log('Global /모집 registered.');
  // Only delete this app's matching legacy command, after successful global upsert.
  for (const guild of guilds) {
    const commands = await request(`/guilds/${guild}/commands`);
    for (const command of commands.filter(c=>c.name==='모집' && c.type===1)) {
      await request(`/guilds/${guild}/commands/${command.id}`,'DELETE');
      console.log(`Removed legacy /모집 in guild ${guild}`);
    }
  }
} catch(error) {
  console.error(error instanceof Error && error.message.startsWith('Discord API ') ? error.message : 'Command synchronization connection failed.');
  process.exitCode=1;
}
