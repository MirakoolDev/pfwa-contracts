// Orders the keeper watches, in a JSON file (INTENTS_STORE, default ./orders.json). BigInts are stored as strings.
import fs from 'node:fs';

const OPEN = new Set(['awaiting_deposit']);

export function openStore(path = process.env.INTENTS_STORE || 'orders.json') {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
      return [];
    }
  };
  const write = (rows) => fs.writeFileSync(path, JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  const revive = (r) => ({
    ...r,
    order: { ...r.order, marketId: BigInt(r.order.marketId), minOut: BigInt(r.order.minOut), deadline: BigInt(r.order.deadline), nonce: BigInt(r.order.nonce) },
  });
  return {
    path,
    add(rec) {
      const rows = read();
      rows.push({ state: 'awaiting_deposit', status: 'PENDING_DEPOSIT', createdAt: new Date().toISOString(), ...rec });
      write(rows);
    },
    all: () => read().map(revive),
    open: () => read().filter((r) => OPEN.has(r.state)).map(revive),
    update(id, patch) {
      write(read().map((r) => (r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r)));
    },
  };
}
