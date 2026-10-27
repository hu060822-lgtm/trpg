// One racer in the unique-item race test: waits for the shared start time, then tries to take the item.
import { CombatStore } from '../../src/persistence/combat-store';
import { WorldStore } from '../../src/persistence/world-store';
import { RULES_V03 } from '../../src/rules/config';
import { scriptedRng } from '../../src/rules/dice';

const [path, characterId, userId, startAt] = process.argv.slice(2);
const store = new WorldStore(new CombatStore(path, RULES_V03), RULES_V03);
while (Date.now() < Number(startAt)) { /* spin so every racer fires at the same moment */ }
try {
  store.submit('greystone', { actor: { userId, role: 'player' }, command: { type: 'take', characterId, itemId: 'bell-heart' } }, scriptedRng([]), new Date());
  console.log(JSON.stringify({ characterId, ok: true }));
} catch (e) {
  console.log(JSON.stringify({ characterId, ok: false, error: (e as Error).message }));
}
