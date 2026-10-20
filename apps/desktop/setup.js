const defaultAddress = 'http://127.0.0.1:11434/v1';
const modelListError = 'Could not list models. Start your local server and make sure a local model is installed, then check again.';
const modelErrors = {
  model_invalid_config: 'Use a local server address ending in /v1.',
  model_unreachable: 'Could not reach your local server. Start it, then check again.',
  model_http_error: 'Your local server refused the request. Check its address and configuration, then try again.',
  model_bad_response: 'The server did not return a usable model list. Check the address and try again.',
  model_list_empty: 'No installed models found. Install a local model, then check again.',
  model_list_too_large: 'The server returned a model list that is too large. Check its configuration and try again.',
  model_not_found: 'The selected model is no longer available. Check for models again.',
  model_timeout: 'The local server took too long to respond. Check that it is running, then try again.',
  model_check_cancelled: 'Model check cancelled. Check again when you are ready.',
};
const form = document.querySelector('#model-form');
const address = document.querySelector('#address');
const model = document.querySelector('#model');
const status = document.querySelector('#status');
const check = document.querySelector('#check');
const open = document.querySelector('#open');
const browse = document.querySelector('#browse');
let loading = true;
let checking = false;
let opening = false;
let checkVersion = 0;
let checkedAddress = '';
let preferredModel = '';

function report(message, state = '') {
  status.textContent = message;
  status.className = state;
}

function updateControls() {
  address.disabled = check.disabled = loading || checking || opening;
  model.disabled = loading || checking || opening || !checkedAddress;
  open.disabled = loading || checking || opening || !checkedAddress || !model.value;
  browse.disabled = loading || opening;
}

function option(id, label = id) {
  const item = document.createElement('option');
  item.value = id;
  item.textContent = label;
  return item;
}

function clearModels() {
  checkedAddress = '';
  model.replaceChildren(option('', 'Check for installed models'));
}

function localAddress() {
  try {
    const url = new URL(address.value.trim());
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        !url.username && !url.password && !url.search && !url.hash && /^\/v1\/?$/.test(url.pathname)) {
      return url.href.replace(/\/$/, '');
    }
  } catch { /* Invalid addresses stay in the field for correction. */ }
  return '';
}

function requireAddress() {
  const value = localAddress();
  address.setCustomValidity(value ? '' : 'Use a local server address such as http://127.0.0.1:11434/v1.');
  if (!value) {
    address.reportValidity();
    report('Enter a local server address ending in /v1.', 'error');
  }
  return value;
}

async function checkModels() {
  if (loading || checking || opening) return;
  const modelBaseUrl = requireAddress();
  if (!modelBaseUrl) return;
  const previous = model.value || preferredModel;
  const version = ++checkVersion;
  clearModels();
  checking = true;
  updateControls();
  report('Checking for models...');
  try {
    // Discover models even if the saved selection was removed from the server.
    const result = await window.rivetSetup.checkModel({ modelBaseUrl, modelId: '' });
    if (version !== checkVersion) return;
    if (result?.error) {
      report(Object.hasOwn(modelErrors, result.code) ? modelErrors[result.code] : modelListError, 'error');
      return;
    }
    if (!Array.isArray(result?.models)) throw new Error('Model list unavailable.');
    const ids = [...new Set(result.models.filter(id => typeof id === 'string' && id.trim() &&
      id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id)))];
    if (!ids.length) {
      report(modelErrors.model_list_empty, 'error');
      return;
    }
    model.replaceChildren(option('', 'Choose a model'), ...ids.map(id => option(id)));
    checkedAddress = modelBaseUrl;
    model.value = ids.includes(previous) ? previous : '';
    report(previous && !model.value
      ? 'Your saved model is no longer listed. Choose another model.'
      : 'Model list loaded. Answer generation has not been tested.', model.value || !previous ? 'success' : '');
  } catch {
    if (version !== checkVersion) return;
    report(modelListError, 'error');
  } finally {
    if (version === checkVersion) {
      checking = false;
      updateControls();
    }
  }
}

async function openWorkspace(withoutModel) {
  if (loading || opening || (checking && !withoutModel)) return;
  const modelBaseUrl = withoutModel ? localAddress() || defaultAddress : requireAddress();
  if (!modelBaseUrl) return;
  if (!withoutModel && (!model.value || checkedAddress !== modelBaseUrl)) {
    report('Check for models and choose one, or browse without a model.', 'error');
    return;
  }
  // Browsing can proceed during a slow model check; ignore its later result.
  ++checkVersion;
  checking = false;
  opening = true;
  updateControls();
  report('Opening your workspace...');
  try {
    const result = await window.rivetSetup.open({ modelBaseUrl, modelId: withoutModel ? '' : model.value });
    if (result?.ok !== true) throw new Error('Workspace unavailable.');
  } catch {
    opening = false;
    report('Rivet could not open. Your setup choices are still here. Try again, or close and reopen the app.', 'error');
    updateControls();
  }
}

address.addEventListener('input', () => {
  address.setCustomValidity('');
  clearModels();
  report('Check for models at this address.');
  updateControls();
});
model.addEventListener('change', () => {
  preferredModel = model.value;
  report('Model list loaded. Answer generation has not been tested.', 'success');
  updateControls();
});
check.addEventListener('click', checkModels);
browse.addEventListener('click', () => openWorkspace(true));
form.addEventListener('submit', event => {
  event.preventDefault();
  void openWorkspace(false);
});

async function initialize() {
  let loaded = false;
  try {
    const config = await window.rivetSetup.config();
    if (config?.error || typeof config?.modelBaseUrl !== 'string' || typeof config?.modelId !== 'string') {
      throw new Error('Settings unavailable.');
    }
    address.value = config.modelBaseUrl;
    preferredModel = config.modelId;
    loaded = true;
  } catch {
    report('Could not read saved model settings. Check your local server address or browse without a model.', 'error');
  } finally {
    loading = false;
    updateControls();
  }
  if (loaded) await checkModels();
}

void initialize();
