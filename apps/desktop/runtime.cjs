const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_CONFIG = Object.freeze({ modelBaseUrl: 'http://127.0.0.1:11434/v1', modelId: '' });

class ModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['modelBaseUrl', 'modelId'].includes(key))) throw new ModelError('model_invalid_config', 'Choose a local model address and model.');
  let url;
  try {
    if (typeof value.modelBaseUrl !== 'string') throw new Error();
    url = new URL(value.modelBaseUrl);
  } catch { throw new ModelError('model_invalid_config', 'Choose a valid local model address.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw new ModelError('model_invalid_config', 'Use a local OpenAI-compatible address such as http://127.0.0.1:11434/v1.');
  }
  if (typeof value.modelId !== 'string' || value.modelId.length > 200 || /[\x00-\x1f\x7f]/.test(value.modelId)) throw new ModelError('model_invalid_config', 'Enter a valid model name.');
  return { modelBaseUrl: url.href.replace(/\/$/, ''), modelId: value.modelId.trim() };
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('Rivet needs a private folder owned by your Mac account.');
  fs.chmodSync(directory, 0o700);
}

function loadConfig(directory) {
  const file = path.join(directory, 'model.json');
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('The local model settings file is invalid.');
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function saveConfig(directory, value) {
  const config = validateConfig(value);
  const file = path.join(directory, 'model.json');
  const temporary = path.join(directory, `model-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return config;
}

function backendEnvironment({ directory, config, port, token }, inherited = process.env) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid desktop launch configuration.');
  const model = validateConfig(config);
  // Only the Mac account and selected local model cross into the backend. No shell/cloud secrets do.
  return {
    HOME: inherited.HOME, TMPDIR: inherited.TMPDIR || '/tmp', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
    NODE_ENV: 'production', HARNESS_PROFILE: 'workspace-analyst', HARNESS_DESKTOP: '1',
    HARNESS_DESKTOP_TOKEN: token, HARNESS_PORT: String(port), HARNESS_APP_ORIGIN: `http://127.0.0.1:${port}`,
    HARNESS_MODEL_BASE_URL: model.modelBaseUrl, HARNESS_MODEL_ID: model.modelId,
    HARNESS_DATA_DIR: path.join(directory, 'workspace'), HARNESS_SOURCE_DIR: path.join(directory, 'sources'),
    HARNESS_CREDENTIAL_KEY_FILE: path.join(directory, 'credentials.key'),
    HARNESS_REPORT_EMAIL_MODE: 'off', HARNESS_ORG_ADMIN: '0', HARNESS_BILLING_MODE: 'off',
    HARNESS_CONNECTIONS_ENABLED: '0',
  };
}

function internalUrl(value, origin) {
  try { const url = new URL(value); return url.protocol === 'http:' && url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

function externalUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

async function checkModel(value, { signal } = {}) {
  const config = validateConfig(value);
  const deadline = AbortSignal.timeout(5000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try {
    requestSignal.throwIfAborted();
    response = await fetch(`${config.modelBaseUrl}/models`, { redirect: 'error', signal: requestSignal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ModelError('model_http_error', 'The local model server did not accept the connection.');
    }
    if (!response.body) throw new ModelError('model_bad_response', 'The local model server returned an invalid model list.');
    let bytes = 0;
    const chunks = [];
    for await (const part of response.body) {
      bytes += part.byteLength;
      if (bytes > 65536) throw new ModelError('model_list_too_large', 'The model list is too large.');
      chunks.push(Buffer.from(part));
    }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    if (!Array.isArray(data?.data)) throw new ModelError('model_bad_response', 'The local model server returned an invalid model list.');
    const models = data.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id)).slice(0, 100);
    if (!models.length) throw new ModelError('model_list_empty', 'The server is running, but no model is installed.');
    if (config.modelId && !models.includes(config.modelId)) throw new ModelError('model_not_found', 'This model was not found on the local server.');
    return { models };
  } catch (error) {
    if (requestSignal.aborted) {
      if (signal?.aborted) throw new ModelError('model_check_cancelled', 'The local model check was cancelled.');
      throw new ModelError('model_timeout', 'The local model server took too long to respond.');
    }
    if (error instanceof ModelError) throw error;
    throw new ModelError(response ? 'model_bad_response' : 'model_unreachable', response
      ? 'The local model server returned an invalid model list.' : 'Could not connect to the local model server.');
  }
}

module.exports = { DEFAULT_CONFIG, ModelError, validateConfig, privateDirectory, loadConfig, saveConfig, backendEnvironment, internalUrl, externalUrl, checkModel };
