// Server administration from the command line. Point DATABASE_URL at the same database as the server
// (the Supabase connection string in production; default ./data/pglite locally):
//   npm run admin -- packs                               list rule packs
//   npm run admin -- import-pack <file.zip | folder>     check and add a rule pack (an add-on is laid over the pack it extends)
//   npm run admin -- check-pack <file.zip | folder>      check a rule pack without adding it
//   npm run admin -- issue-token <userId> [label]        an API token for scripts or tests
//   npm run admin -- issue-service-token [label]         a service token (may act for users with X-Act-As)
//   npm run admin -- revoke-token <token>
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { buildPack, mergePackFiles, PackError, type PackFiles } from '../src/pack/pack';
import { readPackDirFiles, readPackZipFiles } from '../src/pack/zip';
import { openGame } from '../src/server/boot';

const [cmd, ...args] = process.argv.slice(2);
const readFiles = (path: string): PackFiles => (statSync(path).isDirectory() ? readPackDirFiles(path) : readPackZipFiles(readFileSync(path)));
const extendsOf = (files: PackFiles) => (files.manifest as { extends?: unknown } | undefined)?.extends;

if (cmd === 'check-pack') {
  try {
    const files = readFiles(args[0]);
    if (typeof extendsOf(files) === 'string') {
      console.log(`這是擴充包，要疊在 ${extendsOf(files)} 上；用 import-pack 匯入時才會一起檢查`);
      process.exit(0);
    }
    const p = buildPack(files);
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
    case 'import-pack': {
      let files = readFiles(args[0]);
      const base = extendsOf(files);
      if (typeof base === 'string') files = mergePackFiles(await table.packFiles(base), files, base);
      console.log(`added ${await table.savePack(buildPack(files), 'admin', false, new Date(), files)}`);
      break;
    }
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
