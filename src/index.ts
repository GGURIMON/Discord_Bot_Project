import { Repository } from './database/repository';
import { errorResponse, Interactions } from './interactions';
import { verifySignature } from './security';
import { Discord, DiscordError } from './services/discord';
import { MessageSync } from './services/sync';
import { UserError, type Env, type Interaction } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ status: 'ok' });
    if (url.pathname !== '/interactions') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const raw = await request.text();
    if (raw.length > 65536) return new Response('Payload too large', { status: 413 });
    if (!await verifySignature(request, raw, env.DISCORD_PUBLIC_KEY)) return new Response('Invalid signature', { status: 401 });
    let interaction: Interaction;
    try { interaction = JSON.parse(raw) as Interaction; } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!interaction || typeof interaction !== 'object' || interaction.application_id !== env.DISCORD_APPLICATION_ID) return new Response('Invalid application', { status: 401 });
    if (interaction.type === 1) return Response.json({ type: 1 });
    if (![2, 3, 5].includes(interaction.type) || !interaction.id || !interaction.token) return Response.json(errorResponse('지원하지 않는 요청입니다.'));
    if (!interaction.guild_id || !interaction.channel_id || !interaction.member?.user.id) return Response.json(errorResponse('서버 채널에서 /모집을 실행해 주세요.'));
    const handler = new Interactions(new Repository(env.DB), new Discord(env.DISCORD_BOT_TOKEN));
    if (interaction.type === 3 && /^d:\d+:\d+:details:/.test(interaction.data?.custom_id ?? '')) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return Response.json(await Promise.race([
          handler.openModal(interaction),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new UserError('연결이 지연되고 있습니다. 상세 입력 버튼을 다시 눌러 주세요.')), 1800); }),
        ]));
      } catch (error) { return Response.json(errorResponse(error instanceof UserError ? error.message : '입력을 열지 못했습니다. 다시 시도해 주세요.')); }
      finally { clearTimeout(timer); }
    }
    if (interaction.type === 2 && interaction.data?.name === '모집') {
      const panel = handler.handle(interaction).catch(() => ({
        content: '작성 패널을 열지 못했습니다. /모집을 다시 실행해 주세요.',
        components: [], allowed_mentions: { parse: [], replied_user: false },
      }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ready = await Promise.race([
          panel,
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1200); }),
        ]);
        if (ready) return Response.json({ type: 4, data: { ...ready, flags: 64 } });
        ctx.waitUntil(panel.then(payload => handler.discord.reply(interaction, payload)).catch(error => {
          console.warn('panel_reply_failed', interaction.id, error instanceof DiscordError ? error.status : 'internal');
        }));
        return Response.json({ type: 5, data: { flags: 64 } });
      } finally { clearTimeout(timer); }
    }
    ctx.waitUntil(handler.process(interaction));
    const updatePrivatePanel = Boolean(interaction.message && interaction.data?.custom_id?.startsWith('d:')) || interaction.data?.custom_id === 'dismiss' || /^r:[^:]+:cancel:/.test(interaction.data?.custom_id ?? '');
    return Response.json(updatePrivatePanel ? { type: 6 } : { type: 5, data: { flags: 64 } });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const repo = new Repository(env.DB);
    ctx.waitUntil((async () => { await repo.maintenance(); await new MessageSync(repo, new Discord(env.DISCORD_BOT_TOKEN)).drain(); })());
  },
} satisfies ExportedHandler<Env>;
