// Proses terpisah yang membuka file database yang sama lalu mencoba checkout berulang kali.
import { loadConfig } from '../../src/config.ts';
import { Store } from '../../src/db/store.ts';
import { EventBus } from '../../src/lib/bus.ts';
import { AppError } from '../../src/lib/errors.ts';
import { checkout } from '../../src/services/transactions.ts';

const [dbPath, variantId, eventId, cashierId, attempts, tag] = process.argv.slice(2);
const store = new Store(dbPath!).open();
const ctx = { config: loadConfig({}), store, bus: new EventBus(), log: { info() {}, warn() {}, error() {} } };
const cashier = { id: Number(cashierId), username: 'w', displayName: 'w', role: 'cashier' as const };

let ok = 0;
let insufficient = 0;
const other: string[] = [];
for (let i = 0; i < Number(attempts); i++) {
  try {
    checkout(ctx, cashier, {
      clientRequestId: `w-${tag}-${i}-${process.pid}`,
      eventId: Number(eventId),
      paymentMethod: 'cash',
      items: [{ variantId: Number(variantId), quantity: 1 }],
      amountReceived: 1_000_000,
    });
    ok++;
  } catch (err) {
    if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') insufficient++;
    else other.push(String((err as Error).message));
  }
}
store.close();
process.stdout.write(JSON.stringify({ ok, insufficient, other }));
