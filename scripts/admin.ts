// Server administration from the command line. Point DATABASE_URL at the same database as the server
// (the Supabase connection string in production; default ./data/pglite locally):
//   npm run admin -- packs                               list rule packs
//   npm run admin -- import-pack <file.zip>              check and add a rule pack
//   npm run admin -- check-pack <file.zip | folder>      check a rule pack without adding it
//   npm run admin -- issue-token <userId> [label]        an API token for scripts or tests
//   npm run admin -- issue-service-token [label]         a service token (may act for users with X-Act-As)
//   npm run admin -- revoke-token <token>
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { PackError } from '../src/pack/pack';
import { readPackDir, readPackZip } from '../src/pack/zip';
import { openGame } from '../src/server/boot';

const [cmd, ...args] = process.argv.slice(2);
const readPack = (path: string) => (statSync(path).isDirectory() ? readPackDir(path) : readPackZip(readFileSync(path)));

if (cmd === 'check-pack') {
  try {
    const p = readPack(args[0]);
    console.log(`OK: ${p.manifest.name} ${p.manifest.version}（${p.attributes.length} 個屬性、${p.skills.length} 個技能、${p.actions.length} 個動作）`);
  } catch (e) {
    console.error(e instanceof PackError ? e.message : e);
    process.exitCode = 1;
  }
} else {
  const url = process.env.DATABASE_URL ?? './data/pglite';
  if (!url.startsWith('postgres')) mkdirSync(url, { recursive: true });
  const { db, table, auth } = await openGame(url);
  switch (cmd) {
    case 'packs':
      for (const p of await table.listPacks()) console.log(`${p.key}  ${p.name}${p.builtin ? '（內建）' : ''}  ${p.license}`);
      break;
    case 'import-pack':
      console.log(`added ${await table.savePack(readPack(args[0]), 'admin', false)}`);
      break;
    case 'issue-token':
      console.log(await auth.issue(args[0], 'user', args[1] ?? ''));
      break;
    case 'issue-service-token':
      console.log(await auth.issue('service:bot', 'service', args[0] ?? 'service'));
      break;
    case 'revoke-token':
      await auth.revoke(args[0]);
      console.log('revoked');
      break;
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
  }
  await db.close();
}
