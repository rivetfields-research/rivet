import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from './errors.ts';
import { bindingDigest, bindingMatches, boundedRequest, createSingleFlight, newOAuthState, newPkceVerifier, pkceChallenge, writePrivateFileAtomic, type BoundedRequestErrors } from './oauth.ts';
import type { SourceDocument } from './types.ts';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const DOC_TYPE = 'application/vnd.google-apps.document';
const MAX_FILES = 20;
const MAX_CONTENT = 12_000;
const MAX_COLLECTION = 48_000;
const FILE_ID = /^[a-zA-Z0-9_-]{1,200}$/;

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  url: string;
}
export interface GoogleDriveStatus {
  configured: boolean;
  status: 'disconnected' | 'connected' | 'expired';
  account: { id: string; email: string } | null;
  files: GoogleDriveFile[];
  message: string;
}
export interface GoogleDriveSource extends SourceDocument {
  provenance: {
    provider: 'google-drive'; fileId: string; accountLabel: string; url: string;
    modifiedTime: string; retrievedAt: string; contentHash: string; truncated: boolean;
  };
}
export interface GoogleDriveOptions {
  dataDir: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
interface SavedConnection {
  version: 1;
  clientId: string;
  account: { id: string; email: string };
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  files: GoogleDriveFile[];
}
interface PendingAuthorization { bindingHash: Buffer; verifier: string; expiresAt: number; epoch: number; attempt: number }
type Json = Record<string, unknown>;
const fail = (message: string, code: string, status = 400) => new HarnessError(message, status, code);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isObject = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeString = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const accountValid = (value: unknown): value is SavedConnection['account'] => isObject(value) && safeString(value.id, 255) && safeString(value.email, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email as string);
const fileUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** Local single-user connector. Only fixed Google endpoints and selected Google Docs are readable. */
export function createGoogleDrive(options: GoogleDriveOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const configured = Boolean(options.clientId?.trim() && options.clientSecret?.trim());
  const directory = join(options.dataDir, 'connections');
  const storagePath = join(directory, 'google-drive.json');
  const pending = new Map<string, PendingAuthorization>();
  const sources = new Map<string, { fileId: string; hash: string; modifiedTime: string }>();
  let connection: SavedConnection | null = null;
  let storageInvalid = false;
  let connectionEpoch = 0;
  let selectionEpoch = 0;
  let selectionAttempt = 0;
  let authorizationAttempt = 0;
  const refreshing = createSingleFlight<number, string>();
  let disconnecting = false;
  let lastMessage = '';

  function persist(value: SavedConnection) {
    // Atomic 0600 write in a 0700 directory (shared OAuth core). The Drive file stays plaintext JSON (M6 scope).
    try { writePrivateFileAtomic(directory, 'google-drive.json', JSON.stringify(value), 'google-drive'); }
    catch { throw fail('The Drive connection could not be saved securely. Try connecting again.', 'drive_storage', 500); }
  }
  try {
    const fd = openSync(storagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > 64 * 1024) throw new Error();
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!isObject(value) || value.version !== 1 || !accountValid(value.account)
        || typeof value.accessToken !== 'string' || value.accessToken.length > 16_000
        || typeof value.refreshToken !== 'string' || value.refreshToken.length > 16_000
        || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
        || !Array.isArray(value.files) || value.files.length > MAX_FILES
        || value.files.some(file => !isObject(file) || typeof file.id !== 'string' || !FILE_ID.test(file.id)
          || !safeString(file.name, 160) || file.mimeType !== DOC_TYPE || !safeString(file.modifiedTime, 80) || file.url !== fileUrl(file.id))) throw new Error();
      if (value.clientId === options.clientId && configured) {
        connection = value as unknown as SavedConnection;
        chmodSync(storagePath, 0o600);
      }
    } finally { closeSync(fd); }
  } catch (error) {
    if (!(isObject(error) && error.code === 'ENOENT')) { storageInvalid = true; connection = null; }
  }

  function status(): GoogleDriveStatus {
    const active = Boolean(connection?.accessToken && (connection.expiresAt > now() || connection.refreshToken));
    return {
      configured, status: connection ? active ? 'connected' : 'expired' : storageInvalid ? 'expired' : 'disconnected',
      account: connection ? { ...connection.account } : null,
      files: connection?.files.map(file => ({ ...file })) ?? [],
      message: !configured ? 'Google Drive setup is not configured on this server.'
        : lastMessage || (storageInvalid ? 'The saved Drive connection could not be read. Connect again.'
          : connection ? active ? 'Selected Google Docs are available for read-only tasks.' : 'Connect Google Drive again to continue.'
            : 'Connect Google Drive and choose the documents a task may read.'),
    };
  }
  function requireConfigured() {
    if (!configured) throw fail('Google Drive setup is not configured on this server.', 'drive_not_configured', 503);
  }
  function fence(epoch: number, signal?: AbortSignal) {
    if (signal?.aborted) throw fail('The Drive request was cancelled.', 'drive_cancelled', 499);
    if (epoch !== connectionEpoch || !connection?.accessToken) throw fail('The Drive connection changed. Connect again or retry with the current account.', 'drive_connection_changed', 409);
  }
  function selectionFence(epoch: number, revision: number, signal?: AbortSignal) {
    fence(epoch, signal);
    if (revision !== selectionEpoch) throw fail('The selected Drive documents changed. Start the task again.', 'drive_selection_changed', 409);
  }
  function expire(epoch: number) {
    if (epoch !== connectionEpoch || !connection) return;
    const expired = { ...connection, accessToken: '', refreshToken: '', expiresAt: 0 };
    connectionEpoch++;
    selectionEpoch++;
    sources.clear();
    pending.clear();
    connection = expired;
    lastMessage = 'Google authorization expired or was revoked. Connect again.';
    persist(expired);
  }

  const requestErrors: BoundedRequestErrors = {
    cancelled: () => fail('The Drive request was cancelled.', 'drive_cancelled', 499),
    unreachable: () => fail('Google Drive could not be reached. Try again.', 'drive_unavailable', 502),
    unreadable: () => fail('Google Drive response could not be read. Try again.', 'drive_unavailable', 502),
    tooLarge: () => fail('Google returned a response larger than the allowed limit.', 'drive_response_limit', 502),
  };
  function request(url: string, init: RequestInit, limit: number, signal?: AbortSignal, truncate = false) {
    return boundedRequest(fetcher, url, init, { limit, signal, truncate, errors: requestErrors });
  }
  function json(body: string): Json {
    try { const parsed: unknown = JSON.parse(body); if (isObject(parsed)) return parsed; } catch { /* Provider text is not an error message. */ }
    throw fail('Google returned an invalid response.', 'drive_invalid_response', 502);
  }
  function tokenFields(value: Json, requireScopes: boolean) {
    const scopes = typeof value.scope === 'string' ? value.scope.split(' ') : [];
    if (!safeString(value.access_token, 16_000) || typeof value.expires_in !== 'number' || value.expires_in < 1 || value.expires_in > 86_400
      || value.token_type !== 'Bearer' || (requireScopes && !scopes.includes(DRIVE_SCOPE))
      || (value.refresh_token !== undefined && !safeString(value.refresh_token, 16_000))) {
      throw fail('Google did not grant the required Drive access. Connect again.', 'drive_scope_denied', 403);
    }
    if (typeof value.scope === 'string' && !scopes.includes(DRIVE_SCOPE)) throw fail('Google did not grant the required Drive access.', 'drive_scope_denied', 403);
    return { accessToken: value.access_token as string, refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : '', expiresAt: now() + (value.expires_in as number) * 1000 };
  }

  function beginAuthorization(binding: string) {
    requireConfigured();
    if (disconnecting) throw fail('Google Drive is disconnecting. Try connecting again in a moment.', 'drive_busy', 409);
    if (!safeString(binding, 256) || binding.length < 24) throw fail('The browser authorization session is missing.', 'drive_oauth_session');
    let redirect: URL;
    try { redirect = new URL(options.redirectUri); }
    catch { throw fail('Drive authorization requires a configured local callback URL.', 'drive_callback_configuration', 503); }
    if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw fail('Drive authorization requires a configured local callback URL.', 'drive_callback_configuration', 503);
    }
    const state = newOAuthState();
    const verifier = newPkceVerifier();
    // Drive keeps one global pending sign-in (M6 leaves this unchanged); new connectors use per-actor pending state.
    pending.clear();
    pending.set(state, { bindingHash: bindingDigest(binding), verifier, expiresAt: now() + 10 * 60_000, epoch: connectionEpoch, attempt: ++authorizationAttempt });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: options.clientId!, redirect_uri: options.redirectUri, response_type: 'code', scope: `${DRIVE_SCOPE} openid email`, access_type: 'offline', prompt: 'consent select_account', state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' }).toString();
    return { url: url.toString(), state };
  }
  async function completeAuthorization(input: { state: string; code: string; binding: string }, signal?: AbortSignal) {
    requireConfigured();
    const entry = pending.get(input.state);
    pending.delete(input.state);
    if (!entry || entry.expiresAt <= now() || entry.epoch !== connectionEpoch || !bindingMatches(entry.bindingHash, input.binding)
      || !safeString(input.code, 4096)) throw fail('This Drive sign-in link expired or belongs to another browser session. Start again.', 'drive_oauth_state', 403);
    const response = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: options.clientId!, client_secret: options.clientSecret!, code: input.code, code_verifier: entry.verifier, grant_type: 'authorization_code', redirect_uri: options.redirectUri }) }, 32_768, signal);
    if (entry.epoch !== connectionEpoch || entry.attempt !== authorizationAttempt) throw fail('The Drive connection changed during sign-in. Start again.', 'drive_connection_changed', 409);
    if (!response.ok) throw fail('Google sign-in could not be completed. Start again.', 'drive_oauth_failed', 400);
    const tokens = tokenFields(json(response.body), true);
    const identity = await request(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, 16_384, signal);
    if (entry.epoch !== connectionEpoch || entry.attempt !== authorizationAttempt) throw fail('The Drive connection changed during sign-in. Start again.', 'drive_connection_changed', 409);
    if (!identity.ok) throw fail('The Google account could not be verified. Connect again.', 'drive_identity', 403);
    const user = json(identity.body);
    if (!accountValid({ id: user.sub, email: user.email }) || user.email_verified !== true) throw fail('The Google account email could not be verified.', 'drive_identity', 403);
    const account = { id: user.sub as string, email: user.email as string };
    const sameAccount = connection?.account.id === account.id;
    const saved: SavedConnection = { version: 1, clientId: options.clientId!, account, ...tokens, refreshToken: tokens.refreshToken || (sameAccount ? connection!.refreshToken : ''), files: sameAccount ? connection!.files : [] };
    persist(saved);
    connection = saved; storageInvalid = false; lastMessage = '';
    connectionEpoch++; selectionEpoch++; sources.clear(); pending.clear();
    return status();
  }

  async function accessToken(epoch: number, signal?: AbortSignal, force = false): Promise<string> {
    requireConfigured(); fence(epoch, signal);
    if (!force && connection!.expiresAt > now() + 30_000) return connection!.accessToken;
    if (!connection!.refreshToken) { expire(epoch); throw fail('Google authorization expired. Connect again.', 'drive_expired', 401); }
    // Single flight per connection epoch: concurrent callers share one refresh.
    const token = await refreshing.run(epoch, async () => {
      const refresh = connection!.refreshToken;
      const response = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: options.clientId!, client_secret: options.clientSecret!, refresh_token: refresh, grant_type: 'refresh_token' }) }, 32_768);
      fence(epoch);
      if (!response.ok) {
        if ([400, 401, 403].includes(response.status)) { expire(epoch); throw fail('Google authorization expired or was revoked. Connect again.', 'drive_expired', 401); }
        throw fail('Google authorization could not be refreshed. Try again.', 'drive_unavailable', 502);
      }
      let fields;
      try { fields = tokenFields(json(response.body), false); }
      catch (error) { if (error instanceof HarnessError && error.code === 'drive_scope_denied') expire(epoch); throw error; }
      const updated = { ...connection!, ...fields, refreshToken: fields.refreshToken || refresh };
      persist(updated); connection = updated; lastMessage = '';
      return fields.accessToken;
    });
    fence(epoch, signal);
    return token;
  }
  async function api(url: string, epoch: number, signal?: AbortSignal, content = false) {
    let token = await accessToken(epoch, signal);
    let result = await request(url, { headers: { Authorization: `Bearer ${token}` } }, content ? 48_004 : 16_384, signal, content);
    fence(epoch, signal);
    if (result.status === 401) {
      token = await accessToken(epoch, signal, true);
      result = await request(url, { headers: { Authorization: `Bearer ${token}` } }, content ? 48_004 : 16_384, signal, content);
      fence(epoch, signal);
      if (result.status === 401) { expire(epoch); throw fail('Google authorization was rejected. Connect again.', 'drive_expired', 401); }
    }
    if ([403, 404].includes(result.status)) throw fail('This Google Doc is no longer available to the connected account. Choose an accessible document.', 'drive_file_denied', 403);
    if (!result.ok) throw fail('Google Drive could not complete this read. Try again.', 'drive_unavailable', 502);
    return result;
  }
  async function metadata(id: string, epoch: number, signal?: AbortSignal): Promise<GoogleDriveFile> {
    if (!FILE_ID.test(id)) throw fail('Choose a valid Google Doc from the file picker.', 'drive_file_id');
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
    url.search = new URLSearchParams({ fields: 'id,name,mimeType,modifiedTime,trashed,capabilities(canDownload)', supportsAllDrives: 'true' }).toString();
    const result = json((await api(url.toString(), epoch, signal)).body);
    if (result.id !== id || !safeString(result.name, 1000) || result.mimeType !== DOC_TYPE || result.trashed !== false || !safeString(result.modifiedTime, 80)
      || !isObject(result.capabilities) || result.capabilities.canDownload !== true) throw fail('Choose an available Google Doc that allows its content to be read.', 'drive_unsupported_file', 422);
    return { id, name: (result.name as string).slice(0, 160), mimeType: DOC_TYPE, modifiedTime: result.modifiedTime as string, url: fileUrl(id) };
  }
  async function selectFiles(ids: string[], signal?: AbortSignal) {
    requireConfigured();
    if (!Array.isArray(ids) || ids.length > MAX_FILES || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !FILE_ID.test(id))) throw fail('Choose up to 20 different Google Docs.', 'drive_selection');
    const epoch = connectionEpoch;
    fence(epoch, signal);
    // A failed selection must not revoke the unchanged selection used by an active task.
    // This separate counter prevents older selection requests from committing out of order.
    const attempt = ++selectionAttempt;
    const checkSelectionAttempt = () => {
      fence(epoch, signal);
      if (attempt !== selectionAttempt) throw fail('A newer document selection replaced this request.', 'drive_selection_changed', 409);
    };
    const files: GoogleDriveFile[] = [];
    for (const id of ids) { files.push(await metadata(id, epoch, signal)); checkSelectionAttempt(); }
    checkSelectionAttempt();
    const updated = { ...connection!, files };
    persist(updated); connection = updated; sources.clear(); selectionEpoch++; lastMessage = '';
    return status();
  }
  async function fetchSource(fileId: string, epoch: number, revision: number, signal?: AbortSignal): Promise<GoogleDriveSource> {
    selectionFence(epoch, revision, signal);
    if (!connection!.files.some(file => file.id === fileId)) throw fail('This document is outside the selected Drive files.', 'drive_unselected_source', 403);
    const file = await metadata(fileId, epoch, signal);
    selectionFence(epoch, revision, signal);
    const result = await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain`, epoch, signal, true);
    selectionFence(epoch, revision, signal);
    const confirmed = await metadata(fileId, epoch, signal);
    selectionFence(epoch, revision, signal);
    if (confirmed.modifiedTime !== file.modifiedTime) throw fail('This Google Doc changed while being read. Start the task again.', 'drive_source_changed', 409);
    const content = result.body.slice(0, MAX_CONTENT).replace(/[\uD800-\uDBFF]$/, '');
    const contentHash = hash(content);
    const id = `source_${hash(`google-drive\0${connection!.account.id}\0${fileId}\0${file.modifiedTime}\0${contentHash}`).slice(0, 24)}`;
    return { id, title: file.name, path: `Google Drive/${file.name}`, bytes: Buffer.byteLength(content), content,
      provenance: { provider: 'google-drive', fileId, accountLabel: connection!.account.email, url: file.url, modifiedTime: file.modifiedTime, retrievedAt: new Date(now()).toISOString(), contentHash, truncated: result.truncated || result.body.length > MAX_CONTENT } };
  }
  async function list(signal?: AbortSignal): Promise<GoogleDriveSource[]> {
    if (!configured || !connection) return [];
    const epoch = connectionEpoch;
    const revision = selectionEpoch;
    fence(epoch, signal);
    const result: GoogleDriveSource[] = [];
    let size = 0;
    for (const file of connection.files) {
      const source = await fetchSource(file.id, epoch, revision, signal);
      size += source.content.length;
      if (size > MAX_COLLECTION) throw fail('The selected documents exceed the 48,000-character task limit. Choose fewer or shorter documents.', 'drive_collection_limit', 413);
      result.push(source);
    }
    selectionFence(epoch, revision, signal);
    sources.clear();
    for (const source of result) sources.set(source.id, { fileId: source.provenance.fileId, hash: source.provenance.contentHash, modifiedTime: source.provenance.modifiedTime });
    return result;
  }
  async function read(sourceId: string, signal?: AbortSignal): Promise<GoogleDriveSource> {
    const epoch = connectionEpoch;
    const revision = selectionEpoch;
    fence(epoch, signal);
    const selected = sources.get(sourceId);
    if (!selected) throw fail('Refresh the selected Drive documents before reading this source.', 'drive_unknown_source', 403);
    const source = await fetchSource(selected.fileId, epoch, revision, signal);
    if (source.id !== sourceId) throw fail('This Google Doc changed after it was selected for the task. Start the task again to use the updated version.', 'drive_source_changed', 409);
    return source;
  }
  async function pickerSession(signal?: AbortSignal) {
    const epoch = connectionEpoch;
    const token = await accessToken(epoch, signal);
    fence(epoch, signal);
    return { accessToken: token, expiresAt: connection!.expiresAt };
  }
  async function disconnect() {
    if (disconnecting) return status();
    disconnecting = true;
    const token = connection?.refreshToken || connection?.accessToken;
    connectionEpoch++; selectionEpoch++; connection = null; pending.clear(); sources.clear(); storageInvalid = false; lastMessage = '';
    try {
      try { rmSync(storagePath, { force: true }); }
      catch { throw fail('Drive access was stopped, but its saved credentials could not be removed. Check local storage before reconnecting.', 'drive_storage', 500); }
      if (token) {
        try {
          const result = await request(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, 4096);
          if (!result.ok) lastMessage = 'Disconnected locally. Google token revocation could not be confirmed.';
        } catch { lastMessage = 'Disconnected locally. Google token revocation could not be confirmed.'; }
      }
      return status();
    } finally { disconnecting = false; }
  }
  return { status, beginAuthorization, completeAuthorization, pickerSession, selectFiles, disconnect, list, read, revision: () => connectionEpoch + selectionEpoch };
}
