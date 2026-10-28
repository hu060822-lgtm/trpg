// One racer in the unique-item race test: waits for the shared start time, then tries to take the item.
import { CombatStore } from '../../src/persistence/combat-store';
import { openDatabase } from '../../src/persistence/drivers';
import { WorldStore } from '../../src/persistence/world-store';
import { RULES_V03 } from '../../src/rules/config';
import { scriptedRng } from '../../src/rules/dice';

const [url, characterId, userId, startAt] = process.argv.slice(2);
const db = await openDatabase(url);
const store = await WorldStore.open(await CombatStore.open(db, RULES_V03), RULES_V03);
await store.load('greystone'); // warm the connection so every racer fires at the same moment
while (Date.now() < Number(startAt)) { /* spin */ }
try {
  await store.submit('greystone', { actor: { userId, role: 'player' }, command: { type: 'take', characterId, itemId: 'bell-heart' } }, scriptedRng([]), new Date());
  console.log(JSON.stringify({ characterId, ok: true }));
} catch (e) {
  console.log(JSON.stringify({ characterId, ok: false, error: (e as Error).message }));
}
await db.close();
