/** A protocol-only mock. This intentionally does not pretend to test Android encryption. */
export function mockLocalVault() {
  const files = new Map();
  const calls = [];
  const keyOf = ({ accountId, key }) => accountId + '|' + key;
  return {
    files, calls,
    async list(args) { calls.push({ method: 'list', ...args }); return { keys: [...files.keys()].filter((key) => key.startsWith(args.accountId + '|')).map((key) => key.slice(args.accountId.length + 1)) }; },
    async get(args) { calls.push({ method: 'get', ...args }); return { data: files.get(keyOf(args)) ?? null }; },
    async set(args) { calls.push({ method: 'set', ...args }); files.set(keyOf(args), args.data); return { ok: true }; },
    async remove(args) { calls.push({ method: 'remove', ...args }); files.delete(keyOf(args)); return { ok: true }; },
  };
}
