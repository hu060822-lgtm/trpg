import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, type TextBasedChannel } from 'discord.js';
import { GameApi } from './api';
import { COMMANDS, handleCommand } from './commands';
import { Notifier } from './notifier';

/**
 * Discord bot. Env:
 *   DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID   bot credentials and the server (guild) it serves
 *   GAME_API_URL, GAME_SERVICE_TOKEN, WORLD_ID        the game server and the world this guild plays in
 *   WORLD_CHANNEL_ID, GM_CHANNEL_ID                   where public and GM-only history is posted
 *   BOT_STATE_PATH                                    file holding the notification cursor (default ./data/bot-state.json)
 */
const env = (k: string) => process.env[k] ?? (() => { throw new Error(`missing env ${k}`); })();
const api = new GameApi(env('GAME_API_URL'), env('GAME_SERVICE_TOKEN'));
const worldId = env('WORLD_ID');
const statePath = process.env.BOT_STATE_PATH ?? './data/bot-state.json';
mkdirSync(dirname(statePath), { recursive: true });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  await new REST().setToken(env('DISCORD_TOKEN')).put(Routes.applicationGuildCommands(env('DISCORD_APP_ID'), env('DISCORD_GUILD_ID')), { body: COMMANDS });
  console.log(`FATEWEAVE bot ready as ${c.user.tag}, ${COMMANDS.length} commands registered`);

  const channel = async (id: string) => (await client.channels.fetch(id)) as TextBasedChannel & { send(s: string): Promise<unknown> };
  const notifier = new Notifier(api, worldId, async (m) => {
    if (m.to.kind === 'world') await (await channel(env('WORLD_CHANNEL_ID'))).send(m.text);
    else if (m.to.kind === 'gm') await (await channel(env('GM_CHANNEL_ID'))).send(m.text);
    else await (await client.users.fetch(m.to.discordId)).send(m.text);
  }, {
    load: () => JSON.parse(readFileSync(statePath, 'utf8')).cursor as number,
    save: (seq) => writeFileSync(statePath, JSON.stringify({ cursor: seq })),
  });
  // Start from the present on first run, so a new bot does not replay the whole history into the channels.
  if (!existsSync(statePath)) {
    const feed = await api.feed(worldId, 0);
    writeFileSync(statePath, JSON.stringify({ cursor: feed.events.at(-1)?.seq ?? 0 }));
  }
  setInterval(() => { notifier.poll().catch((e) => console.error('[notifier]', (e as Error).message)); }, 15_000);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  const options: Record<string, string | number | undefined> = {};
  for (const o of i.options.data.flatMap((d) => (d.options ? d.options : [d]))) if (o.value !== undefined) options[o.name] = o.value as string | number;
  const sub = i.options.getSubcommand(false) ?? undefined;
  const r = await handleCommand(api, worldId, { userId: i.user.id, command: i.commandName, sub, options });
  await i.reply({ content: r.content, embeds: r.embeds, flags: r.ephemeral ? MessageFlags.Ephemeral : undefined });
});

client.login(env('DISCORD_TOKEN'));
