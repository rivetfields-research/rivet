import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectionStore } from './connections.ts';
import { createCredentialVault, credentialAad, credentialKeysFromBuffers, credentialKeysFromEnv, type CredentialKeyProvider } from './credential-vault.ts';
import { HarnessError } from './errors.ts';
import { createHarness, type ModelProvider } from './index.ts';

const SECRET = { accessToken: 'fictional-access-token-value', refreshToken: 'fictional-refresh-token-value', obtainedAt: 1 };
const owner = { issuer: 'https://login.example.test/v2.0', subject: 'fictional-owner' };
const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected
  && !String(error.message).includes('fictional-access-token-value') && !String(error.message).includes('/');
const key = () => randomBytes(32);

function fixture(t: TestContext, keys?: CredentialKeyProvider) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const store = createConnectionStore(db);
  const provider = keys ?? credentialKeysFromBuffers({ 1: key() }, 1);
  const vault = createCredentialVault(db, { keys: provider, connectionOf: id => store.get(id) });
  const connect = (over: Record<string, unknown> = {}) => store.create({ workspaceId: 'person_fictional', owner, provider: 'meta', displayName: 'Fictional Page', providerAccountId: `page-${randomBytes(4).toString('hex')}`, ...over });
  const sealed = (id: string) => db.prepare('SELECT key_version, sealed FROM connection_credentials WHERE connection_id=?').get(id) as { key_version: number; sealed: Uint8Array };
  return { db, store, vault, connect, sealed, keys: provider };
}
function tempDir(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function keyFile(directory: string, name: string, content: Buffer | string, mode = 0o600) {
  const path = join(directory, name);
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

test('S-01 seal and open round trip stores only the reviewed ciphertext columns', t => {
  const f = fixture(t);
  const connection = f.connect();
  assert.equal(f.vault.open(connection.id), undefined);
  f.vault.seal(connection.id, SECRET);
  assert.deepEqual(f.vault.open(connection.id), SECRET);
  assert.equal(f.vault.has(connection.id), true);
  assert.deepEqual(f.db.prepare('PRAGMA table_info(connection_credentials)').all().map(row => [row.name, row.type, row.notnull, row.pk]),
    [['connection_id', 'TEXT', 0, 1], ['key_version', 'INTEGER', 1, 0], ['sealed', 'BLOB', 1, 0], ['updated_at', 'TEXT', 1, 0]]);
  const first = Buffer.from(f.sealed(connection.id).sealed);
  // format byte, 96-bit nonce, 128-bit tag, then ciphertext; the plaintext never appears.
  assert.equal(first[0], 1);
  assert.ok(first.length > 1 + 12 + 16);
  assert.equal(first.includes(Buffer.from('fictional-access-token-value')), false);
  f.vault.seal(connection.id, SECRET);
  const second = Buffer.from(f.sealed(connection.id).sealed);
  assert.notDeepEqual(second.subarray(1, 13), first.subarray(1, 13), 'every seal uses a fresh nonce');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM connection_credentials').get()!.n, 1, 'a re-seal replaces the row');
  assert.throws(() => f.vault.seal(connection.id, [] as unknown as Record<string, unknown>), code('invalid_credentials'));
  assert.throws(() => f.vault.seal(connection.id, { blob: 'x'.repeat(33 * 1024) }), code('invalid_credentials'));
  assert.throws(() => f.vault.seal('conn_000000000000000000000000', SECRET), code('connection_not_found'));
});

test('S-01 a tampered format, nonce, tag or ciphertext fails closed without echoing the secret', t => {
  const f = fixture(t);
  const connection = f.connect();
  f.vault.seal(connection.id, SECRET);
  const original = Buffer.from(f.sealed(connection.id).sealed);
  for (const [label, offset] of [['format', 0], ['nonce', 5], ['tag', 20], ['ciphertext', original.length - 1]] as const) {
    const tampered = Buffer.from(original);
    tampered[offset] ^= 0x01;
    f.db.prepare('UPDATE connection_credentials SET sealed=? WHERE connection_id=?').run(tampered, connection.id);
    assert.throws(() => f.vault.open(connection.id), code('credential_unreadable'), label);
  }
  f.db.prepare('UPDATE connection_credentials SET sealed=? WHERE connection_id=?').run(original.subarray(0, 20), connection.id);
  assert.throws(() => f.vault.open(connection.id), code('credential_unreadable'), 'truncated');
  f.db.prepare('UPDATE connection_credentials SET sealed=? WHERE connection_id=?').run(original, connection.id);
  assert.deepEqual(f.vault.open(connection.id), SECRET);
});

test('S-01 the AAD binds each row: a swapped row, a changed owner, workspace, provider or account fails', t => {
  const f = fixture(t);
  const a = f.connect();
  const b = f.connect();
  f.vault.seal(a.id, SECRET);
  f.vault.seal(b.id, { accessToken: 'second-account-token', obtainedAt: 2 });
  assert.equal(credentialAad(a, 1).toString(), `person_fictional|${owner.issuer}|${owner.subject}|meta|${a.accountKey}|${a.id}|1`);
  assert.equal(credentialAad({ ...a, workspaceId: 'local', owner: null }, 3).toString(), `local|||meta|${a.accountKey}|${a.id}|3`);
  assert.throws(() => credentialAad({ ...a, owner: { issuer: 'https://x|y', subject: 's' } }, 1), code('credential_binding_invalid'));
  assert.throws(() => credentialAad({ ...a, owner: { issuer: owner.issuer, subject: 'a|b' } }, 1), code('credential_binding_invalid'));
  // Copy A's sealed row onto B: the ciphertext is valid, but it was bound to A.
  const aRow = f.sealed(a.id);
  f.db.prepare('UPDATE connection_credentials SET sealed=?, key_version=? WHERE connection_id=?').run(aRow.sealed, aRow.key_version, b.id);
  assert.throws(() => f.vault.open(b.id), code('credential_unreadable'));
  assert.deepEqual(f.vault.open(a.id), SECRET);
  const saved = f.db.prepare('SELECT data FROM connections WHERE id=?').get(a.id)!.data as string;
  for (const change of [{ owner: { ...owner, subject: 'another-person' } }, { workspaceId: 'person_other' }, { provider: 'instagram' }, { accountKey: 'f'.repeat(32) }]) {
    f.db.prepare('UPDATE connections SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(saved), ...change }), a.id);
    assert.throws(() => f.vault.open(a.id), code('credential_unreadable'), JSON.stringify(change));
  }
  f.db.prepare('UPDATE connections SET data=? WHERE id=?').run(saved, a.id);
  assert.deepEqual(f.vault.open(a.id), SECRET);
});

test('S-01 the wrong key, or a relabelled key version, fails', t => {
  const one = key();
  const two = key();
  const f = fixture(t, credentialKeysFromBuffers({ 1: one, 2: two }, 1));
  const connection = f.connect();
  f.vault.seal(connection.id, SECRET);
  // The key_version column is part of the AAD: relabelling the row to version 2 fails even though key 2 exists.
  f.db.prepare('UPDATE connection_credentials SET key_version=2 WHERE connection_id=?').run(connection.id);
  assert.throws(() => f.vault.open(connection.id), code('credential_unreadable'));
  f.db.prepare('UPDATE connection_credentials SET key_version=1 WHERE connection_id=?').run(connection.id);
  const wrongKey = createCredentialVault(f.db, { keys: credentialKeysFromBuffers({ 1: two }, 1), connectionOf: id => f.store.get(id) });
  assert.throws(() => wrongKey.open(connection.id), code('credential_unreadable'));
  const missingVersion = createCredentialVault(f.db, { keys: credentialKeysFromBuffers({ 2: two }, 2), connectionOf: id => f.store.get(id) });
  assert.throws(() => missingVersion.open(connection.id), error => code('credential_setup_required')(error) && /Setup required/.test((error as Error).message));
});

test('S-02 rotation re-seals every row; older keys open unrotated rows until rotation completes', t => {
  const one = key();
  const two = key();
  const f = fixture(t, credentialKeysFromBuffers({ 1: one }, 1));
  const connections = [f.connect(), f.connect(), f.connect()];
  connections.forEach((connection, index) => f.vault.seal(connection.id, { ...SECRET, obtainedAt: index }));
  const tampered = f.connect();
  f.vault.seal(tampered.id, SECRET);
  const bad = Buffer.from(f.sealed(tampered.id).sealed); bad[bad.length - 1] ^= 1;
  f.db.prepare('UPDATE connection_credentials SET sealed=? WHERE connection_id=?').run(bad, tampered.id);

  // New current key version 2; version 1 stays configured for decryption only.
  const rotating = createCredentialVault(f.db, { keys: credentialKeysFromBuffers({ 1: one, 2: two }, 2), connectionOf: id => f.store.get(id) });
  connections.forEach((connection, index) => assert.deepEqual(rotating.open(connection.id), { ...SECRET, obtainedAt: index }, 'old version still opens'));
  rotating.seal(connections[0]!.id, { ...SECRET, obtainedAt: 0 });
  assert.equal(f.sealed(connections[0]!.id).key_version, 2, 'a new seal uses the current version');
  const result = rotating.rotate();
  assert.deepEqual(result, { currentVersion: 2, resealed: 2, unchanged: 1, skipped: 0, failed: [tampered.id] });
  for (const connection of connections) assert.equal(f.sealed(connection.id).key_version, 2);
  assert.equal(f.sealed(tampered.id).key_version, 1, 'an unreadable row is reported and left unchanged, never deleted');
  // After rotation, version 1 can be removed from configuration.
  const rotated = createCredentialVault(f.db, { keys: credentialKeysFromBuffers({ 2: two }, 2), connectionOf: id => f.store.get(id) });
  connections.forEach((connection, index) => assert.deepEqual(rotated.open(connection.id), { ...SECRET, obtainedAt: index }));
  assert.deepEqual(rotated.rotate(), { currentVersion: 2, resealed: 0, unchanged: 3, skipped: 0, failed: [tampered.id] });
  // A disconnected connection's row is skipped, never re-sealed.
  const gone = f.connect();
  rotated.seal(gone.id, SECRET);
  const three = key();
  f.store.update(gone.id, { version: gone.version, status: 'disconnected' });
  const later = createCredentialVault(f.db, { keys: credentialKeysFromBuffers({ 2: two, 3: three }, 3), connectionOf: id => f.store.get(id) });
  const skipped = later.rotate();
  assert.equal(skipped.skipped, 1);
  assert.equal(f.sealed(gone.id).key_version, 2);
});

test('S-03 a missing or unusable key gives "Setup required" and never falls back to plaintext', t => {
  const unconfigured = fixture(t, credentialKeysFromEnv({}, { mode: 'hosted', dataDirs: [tempDir(t, 'vault-data-')] }));
  const connection = unconfigured.connect();
  const status = unconfigured.vault.status();
  assert.equal(status.ready, false);
  assert.equal(status.code, 'credential_setup_required');
  assert.equal(status.reason, 'key_not_configured');
  assert.match(status.message, /^Setup required: /);
  assert.throws(() => unconfigured.vault.seal(connection.id, SECRET), code('credential_setup_required'));
  assert.equal(unconfigured.db.prepare('SELECT count(*) AS n FROM connection_credentials').get()!.n, 0, 'nothing is stored without a key');
  // A vault with no key provider at all behaves the same.
  const none = createCredentialVault(unconfigured.db, { connectionOf: id => unconfigured.store.get(id) });
  assert.equal(none.status().ready, false);
  assert.throws(() => none.seal(connection.id, SECRET), code('credential_setup_required'));
  // A saved row cannot be opened without its key: it is refused, never read as plaintext.
  const sealedWithKey = createCredentialVault(unconfigured.db, { keys: credentialKeysFromBuffers({ 1: key() }, 1), connectionOf: id => unconfigured.store.get(id) });
  sealedWithKey.seal(connection.id, SECRET);
  assert.throws(() => none.open(connection.id), code('credential_setup_required'));
  assert.throws(() => unconfigured.vault.open(connection.id), code('credential_setup_required'));
});

test('S-03 the key file must be absolute, outside the data directory, private, and exactly 32 bytes', t => {
  const data = tempDir(t, 'vault-data-');
  const keys = tempDir(t, 'vault-keys-');
  chmodSync(keys, 0o700);
  const reason = (env: Record<string, string>, dataDirs = [data]) => credentialKeysFromEnv(env, { mode: 'hosted', dataDirs }).status();
  const raw = key();
  assert.deepEqual(reason({ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'raw.key', raw) }), { ready: true, message: 'Credential sealing is ready.', currentVersion: 1 });
  assert.equal(reason({ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'b64.key', `${raw.toString('base64')}\n`, 0o400) }).ready, true);
  assert.equal(reason({ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'b64url.key', raw.toString('base64url')) }).ready, true);
  const cases: [Record<string, string>, string][] = [
    [{ HARNESS_CREDENTIAL_KEY_FILE: 'relative/credentials.key' }, 'key_path'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: join(keys, 'missing.key') }, 'key_missing'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'shared.key', raw, 0o640) }, 'key_permissions'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'world.key', raw, 0o604) }, 'key_permissions'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'short.key', randomBytes(31)) }, 'key_size'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'long.key', randomBytes(33)) }, 'key_size'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'text.key', 'not a key at all') }, 'key_size'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(data, 'credentials.key', raw) }, 'key_location'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keys }, 'key_permissions'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'v.key', raw), HARNESS_CREDENTIAL_KEY_VERSION: '0' }, 'key_version'],
    [{ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'dup.key', raw), HARNESS_CREDENTIAL_KEY_FILE_V1: keyFile(keys, 'dup1.key', raw) }, 'key_version'],
  ];
  mkdirSync(join(keys, 'nested'), { mode: 0o700 });
  symlinkSync(join(keys, 'raw.key'), join(keys, 'nested', 'link.key'));
  cases.push([{ HARNESS_CREDENTIAL_KEY_FILE: join(keys, 'nested', 'link.key') }, 'key_permissions']);
  // A symlinked directory cannot hide a key that is really inside the data directory.
  mkdirSync(join(data, 'hidden'), { mode: 0o700 });
  keyFile(join(data, 'hidden'), 'credentials.key', raw);
  symlinkSync(join(data, 'hidden'), join(keys, 'alias'));
  cases.push([{ HARNESS_CREDENTIAL_KEY_FILE: join(keys, 'alias', 'credentials.key') }, 'key_location']);
  for (const [env, expected] of cases) {
    const status = reason(env);
    assert.equal(status.ready, false, JSON.stringify(env));
    assert.equal(status.reason, expected, JSON.stringify(env));
    assert.match(status.message, /^Setup required: /);
    assert.equal(status.message.includes(keys) || status.message.includes(data), false, 'no path in the message');
  }
  // An older version is only needed to open rows sealed with it.
  const provider = credentialKeysFromEnv({ HARNESS_CREDENTIAL_KEY_FILE: keyFile(keys, 'current.key', raw), HARNESS_CREDENTIAL_KEY_VERSION: '3', HARNESS_CREDENTIAL_KEY_FILE_V2: keyFile(keys, 'old.key', key()) }, { mode: 'hosted', dataDirs: [data] });
  assert.equal(provider.current().version, 3);
  assert.equal(provider.get(2).version, 2);
  assert.throws(() => provider.get(1), code('credential_setup_required'));
});

test('S-03 local mode creates the default key with mode 0600 on first use only', t => {
  const home = tempDir(t, 'vault-home-');
  const data = tempDir(t, 'vault-data-');
  const provider = credentialKeysFromEnv({}, { mode: 'local', dataDirs: [data], homeDir: home });
  const path = join(home, '.config', 'rivetfields', 'credentials.key');
  assert.equal(provider.status().ready, true);
  assert.equal(existsSync(path), false, 'status never creates the key');
  const first = provider.current();
  assert.equal(first.key.length, 32);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, '.config', 'rivetfields')).mode & 0o777, 0o700);
  assert.deepEqual(credentialKeysFromEnv({}, { mode: 'local', dataDirs: [data], homeDir: home }).current().key, first.key, 'the saved key is reused');
  // Hosted mode never creates a default.
  assert.equal(credentialKeysFromEnv({}, { mode: 'hosted', dataDirs: [data], homeDir: tempDir(t, 'vault-home-') }).status().reason, 'key_not_configured');
  // A local default inside the data directory is refused rather than created there.
  assert.equal(credentialKeysFromEnv({}, { mode: 'local', dataDirs: [home] }).status().ready, true);
  assert.throws(() => credentialKeysFromEnv({}, { mode: 'local', dataDirs: [home], homeDir: home }).current(), code('credential_setup_required'));
});

test('token stores are generation-bound: disconnect, reconnect or a new sign-in supersede older stores', t => {
  const f = fixture(t);
  const connection = f.connect();
  f.vault.seal(connection.id, SECRET);
  const store = f.vault.tokenStore(connection.id);
  assert.equal(store.load()?.accessToken, SECRET.accessToken);
  store.save({ ...SECRET, accessToken: 'refreshed-token' });
  assert.equal(f.vault.open(connection.id)?.accessToken, 'refreshed-token', 'a current store writes');
  for (const supersede of [() => f.vault.seal(connection.id, SECRET), () => f.vault.supersede(connection.id)]) {
    const before = f.vault.tokenStore(connection.id);
    supersede();
    assert.throws(() => before.save({ ...SECRET, accessToken: 'stale-token' }), code('credential_superseded'));
    assert.throws(() => before.load(), code('credential_superseded'));
    before.remove();
    assert.equal(f.vault.has(connection.id), true, 'a superseded store deletes nothing');
  }
  const afterRemove = f.vault.tokenStore(connection.id);
  f.vault.remove(connection.id);
  assert.throws(() => afterRemove.save(SECRET as never), code('credential_superseded'));
  assert.equal(f.vault.has(connection.id), false);
});

const model: ModelProvider = {
  status: async () => ({ configured: true, available: true, model: 'scripted-test', kind: 'openai-compatible', label: 'Scripted test', message: 'No model inference' }),
  complete: async () => ({ content: JSON.stringify({ type: 'reply', content: 'Scripted reply.' }) }),
};
function harness(t: TestContext, options: Partial<Parameters<typeof createHarness>[0]> = {}) {
  const root = tempDir(t, 'vault-harness-');
  mkdirSync(join(root, 'sources'));
  writeFileSync(join(root, 'sources', 'approved.md'), '# Approved\nFictional note.');
  const base = { dataDir: join(root, 'data'), sourceDir: join(root, 'sources'), modelBaseUrl: 'http://127.0.0.1:1/v1', provider: model };
  const open = (extra: Partial<Parameters<typeof createHarness>[0]> = {}) => createHarness({ ...base, ...options, ...extra });
  return { root, dataDir: base.dataDir, open };
}
const tables = (dataDir: string) => {
  const db = new DatabaseSync(join(dataDir, 'harness.sqlite'), { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name as string); } finally { db.close(); }
};

test('the harness keeps no credential table with connections off, and destroys credentials on disconnect (D-9)', async t => {
  const off = harness(t);
  const disabled = off.open();
  assert.equal(disabled.credentialSetup().ready, false);
  await disabled.close();
  assert.equal(tables(off.dataDir).includes('connection_credentials'), false);

  const h = harness(t, { connections: { enabled: true, providers: {} }, credentialKeys: credentialKeysFromBuffers({ 1: key() }, 1) });
  let api = h.open();
  assert.equal(api.credentialSetup().ready, true);
  const connection = await api.createConnection({ provider: 'fake', displayName: 'Fictional exports' });
  await api.saveConnectionCredentials(connection.id, SECRET);
  const version = api.recordConnectionVersion({ id: 'sync-attempt-0001', connectionId: connection.id, kind: 'tabular', datasetId: 'dataset_fictional', sourceId: 'source_fictional', contentHash: 'a'.repeat(64), observedAt: '2026-09-30T09:00:00.000Z' });
  const count = () => {
    const db = new DatabaseSync(join(h.dataDir, 'harness.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT count(*) AS n FROM connection_credentials').get()!.n; } finally { db.close(); }
  };
  assert.equal(count(), 1);
  const disconnected = await api.updateConnection(connection.id, { version: connection.version, status: 'disconnected' });
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(count(), 0, 'disconnect destroys the sealed row');
  assert.deepEqual(api.listConnectionVersions(connection.id), [version.version], 'synced versions are kept');
  await assert.rejects(api.saveConnectionCredentials(connection.id, SECRET), code('connection_disconnected'));
  assert.deepEqual(api.rotateCredentials(), { currentVersion: 1, resealed: 0, unchanged: 0, skipped: 0, failed: [] });
  await api.close();

  // A credential row left for a disconnected connection (e.g. a crash between the two writes) is destroyed at startup.
  const db = new DatabaseSync(join(h.dataDir, 'harness.sqlite'));
  db.prepare('INSERT INTO connection_credentials VALUES (?,?,?,?)').run(connection.id, 1, Buffer.from([1, 2, 3]), '2026-09-30T09:00:00.000Z');
  db.close();
  api = h.open();
  assert.equal(count(), 0);
  await api.close();
});

test('S-08 sealed credentials never appear in listings, status, errors or the saved database bytes', async t => {
  const h = harness(t, { connections: { enabled: true, providers: {} }, credentialKeys: credentialKeysFromBuffers({ 1: key() }, 1) });
  const api = h.open();
  const connection = await api.createConnection({ provider: 'fake', displayName: 'Fictional exports' });
  await api.saveConnectionCredentials(connection.id, SECRET);
  const visible = JSON.stringify([api.listConnections(), api.connectionSettings(), api.credentialSetup(), await api.workspace(), api.listConnectionVersions(connection.id)]);
  for (const secret of [SECRET.accessToken, SECRET.refreshToken]) assert.equal(visible.includes(secret), false);
  assert.equal(Object.keys(api).some(name => /^(read|open|get)[A-Za-z]*Credential/.test(name)), false, 'the harness exposes no credential read');
  await api.close();
  for (const name of readdirSync(h.dataDir)) {
    if (!name.startsWith('harness.sqlite')) continue;
    const bytes = readFileSync(join(h.dataDir, name));
    for (const secret of [SECRET.accessToken, SECRET.refreshToken]) assert.equal(bytes.includes(Buffer.from(secret)), false, name);
  }
});

test('a hosted connection accepts credentials only from its own verified owner', async t => {
  const actor = { workspaceId: 'person_fictional', actor: owner };
  const other = { workspaceId: 'person_fictional', actor: { ...owner, subject: 'another-person' } };
  const h = harness(t, { mode: 'hosted', connections: { enabled: true, providers: {} }, credentialKeys: credentialKeysFromBuffers({ 1: key() }, 1),
    authorization: { workspaceId: actor.workspaceId, checkPermission: async () => {} } });
  const api = h.open();
  t.after(() => api.close());
  const connection = await api.createConnection({ provider: 'fake', displayName: 'Fictional exports' }, actor);
  await assert.rejects(api.saveConnectionCredentials(connection.id, SECRET), /authenticated workspace actor/);
  await assert.rejects(api.saveConnectionCredentials(connection.id, SECRET, other), code('connection_owner_mismatch'));
  await api.saveConnectionCredentials(connection.id, SECRET, actor);
  await assert.rejects(api.saveConnectionCredentials('conn_000000000000000000000000', SECRET, actor), code('connection_not_found'));
});
