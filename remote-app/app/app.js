const launchSettings = getLaunchSettings();

const state = {
  apiUrl: launchSettings.apiUrl || localStorage.getItem('homeops.apiUrl') || window.location.origin,
  token: launchSettings.token || localStorage.getItem('homeops.token') || '',
  screen: localStorage.getItem('homeops.screen') || 'overview',
  busy: false,
  busyRows: new Set(),
  lastStatus: null,
  plexDuplicateFilter: localStorage.getItem('homeops.plexDuplicateFilter') || 'all',
  plexCleanupPreview: null,
  cleanupProgress: null,
  cleanupProgressTimer: null,
  silenced: readSilenced(),
  endpointStates: {}
};

if (launchSettings.apiUrl) localStorage.setItem('homeops.apiUrl', launchSettings.apiUrl);
if (launchSettings.token) localStorage.setItem('homeops.token', launchSettings.token);

const API_FALLBACK_URLS = [
  window.location.origin,
  'https://kevin-pc.taile05f72.ts.net',
  'http://kevin-pc.taile05f72.ts.net:8080',
  'http://100.97.88.6:8787',
  'http://192.168.1.86:8787'
];

const els = {};
for (const id of [
  'apiUrl', 'apiToken', 'saveSettings', 'refreshStatus', 'refreshStatus2', 'connectionPill', 'connectionDot',
  'serverLine', 'commandState', 'verdictBar', 'verdictHeadline', 'verdictSub', 'alertList', 'quietList',
  'lastHomeopsRun', 'lastHaRun', 'systemsHeadline', 'systemsList', 'haHeadline', 'haSub', 'haEntities',
  'haUnavailable', 'batteryState', 'haServices', 'haFindings', 'quickActions', 'commandForm', 'commandText',
  'sendCommand', 'queueMessage', 'plexHeadline', 'plexDupHeadline', 'plexDupMeta', 'plexDupState',
  'scanPlexDuplicates', 'previewPlexDuplicates', 'approvePlexDuplicates', 'plexDupVisible', 'plexApprovalState',
  'plexStagedDetail', 'plexCleanupPlan', 'plexDupList', 'activityList', 'activityCount', 'endpointList',
  'connHeadline', 'confirmBackdrop', 'confirmTitle', 'confirmBody', 'confirmRows', 'confirmField',
  'confirmPromptLabel', 'confirmWord', 'confirmCancel', 'confirmGo', 'toast', 'systemRowTemplate',
  'navBadgeOverview', 'navBadgePlex', 'navBadgeSystems', 'navBadgeHa'
]) {
  els[id] = document.getElementById(id);
}

/* ---------------- helpers ---------------- */

function getLaunchSettings() {
  const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const rawSearch = window.location.search.startsWith('?') ? window.location.search.slice(1) : '';
  const params = new URLSearchParams(rawHash || rawSearch);
  const token = String(params.get('token') || params.get('homeopsToken') || '').trim();
  const apiUrl = normalizeUrl(params.get('apiUrl') || params.get('api') || '');
  if (token || apiUrl) {
    window.history.replaceState(null, document.title, `${window.location.origin}${window.location.pathname}`);
  }
  return { token, apiUrl };
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function readSilenced() {
  try {
    const raw = JSON.parse(localStorage.getItem('homeops.silenced') || '{}');
    const now = Date.now();
    const live = {};
    for (const [key, until] of Object.entries(raw)) {
      if (Number(until) > now) live[key] = Number(until);
    }
    return live;
  } catch (error) {
    return {};
  }
}

function silence(key) {
  state.silenced[key] = Date.now() + 24 * 60 * 60 * 1000;
  localStorage.setItem('homeops.silenced', JSON.stringify(state.silenced));
  toast('Silenced for 24 hours.');
  if (state.lastStatus) renderStatus(state.lastStatus);
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2800);
}

function setConnection(label, tone) {
  els.connectionPill.textContent = label;
  els.connectionDot.className = `dot ${tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : ''}`;
  els.connectionPill.className = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted';
  els.connHeadline.textContent = tone === 'good' ? 'Connected to the control PC.' : `Connection: ${label}.`;
}

function setScreen(id) {
  state.screen = id;
  localStorage.setItem('homeops.screen', id);
  for (const section of document.querySelectorAll('.screen')) {
    section.classList.toggle('active', section.id === `screen-${id}`);
  }
  for (const button of document.querySelectorAll('.nav-item')) {
    button.classList.toggle('active', button.dataset.screen === id);
  }
  window.scrollTo(0, 0);
}

/* Only the acting control goes quiet - the rest of the page stays usable. */
function setBusy(isBusy, label = 'Working', scope = null) {
  state.busy = isBusy;
  els.commandState.textContent = isBusy ? label : 'Idle';
  const buttons = scope ? scope.querySelectorAll('button') : [];
  for (const button of buttons) button.disabled = isBusy;
}

function setRowBusy(rowId, isBusy) {
  if (isBusy) state.busyRows.add(rowId); else state.busyRows.delete(rowId);
  const row = els.plexDupList.querySelector(`[data-row-id="${rowId}"]`);
  if (!row) return;
  row.classList.toggle('row-busy', isBusy);
  for (const button of row.querySelectorAll('button')) button.disabled = isBusy;
}

/* ---------------- confirmation dialog (replaces window.prompt) ---------------- */

let confirmResolver = null;

function openConfirm(options) {
  els.confirmTitle.textContent = options.title;
  els.confirmBody.textContent = options.body;
  els.confirmRows.replaceChildren();
  for (const row of toArray(options.rows)) {
    const item = el('div', 'dialog-row');
    item.append(el('strong', null, row.title));
    if (row.path) item.append(el('span', null, row.path));
    els.confirmRows.appendChild(item);
  }
  const word = options.word || '';
  const freeText = Boolean(options.freeText);
  els.confirmField.classList.toggle('hidden', !word && !freeText);
  els.confirmPromptLabel.textContent = word ? `Type ${word} to continue` : (options.promptLabel || '');
  els.confirmWord.value = '';
  els.confirmWord.placeholder = word || (options.placeholder || '');
  els.confirmGo.textContent = options.goLabel || 'Continue';
  els.confirmGo.className = options.danger ? 'danger' : 'primary';
  els.confirmGo.disabled = Boolean(word);
  els.confirmGo.dataset.word = word;
  els.confirmBackdrop.classList.add('open');
  if (word) els.confirmWord.focus();
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function closeConfirm(result) {
  els.confirmBackdrop.classList.remove('open');
  if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
}

els.confirmWord.addEventListener('input', () => {
  const word = els.confirmGo.dataset.word || '';
  els.confirmGo.disabled = word ? els.confirmWord.value.trim().toUpperCase() !== word : false;
});
els.confirmWord.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !els.confirmGo.disabled) closeConfirm(true);
});
els.confirmCancel.addEventListener('click', () => closeConfirm(false));
els.confirmGo.addEventListener('click', () => closeConfirm(true));
els.confirmBackdrop.addEventListener('click', (event) => {
  if (event.target === els.confirmBackdrop) closeConfirm(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && els.confirmBackdrop.classList.contains('open')) closeConfirm(false);
});

/* ---------------- api ---------------- */

async function apiFetch(path, options = {}) {
  const url = `${normalizeUrl(state.apiUrl)}${path}`;
  const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${state.token}` });
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, Object.assign({}, options, { headers }));
  const text = await response.text();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); } catch (error) { payload = { ok: false, error: text }; }
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function fetchStatusFrom(baseUrl) {
  const previousUrl = state.apiUrl;
  state.apiUrl = normalizeUrl(baseUrl);
  try {
    return await apiFetch('/api/status');
  } catch (error) {
    state.apiUrl = previousUrl;
    throw error;
  }
}

async function loadStatusWithFallbacks() {
  const candidates = [state.apiUrl, ...API_FALLBACK_URLS]
    .map(normalizeUrl)
    .filter(Boolean)
    .filter((url, index, urls) => urls.indexOf(url) === index);

  let lastError = null;
  for (const url of candidates) {
    try {
      const payload = await fetchStatusFrom(url);
      state.apiUrl = normalizeUrl(url);
      state.endpointStates[state.apiUrl] = 'in use';
      els.apiUrl.value = state.apiUrl;
      localStorage.setItem('homeops.apiUrl', state.apiUrl);
      renderEndpoints();
      return payload;
    } catch (error) {
      state.endpointStates[normalizeUrl(url)] = 'no answer';
      lastError = error;
    }
  }
  renderEndpoints();
  throw lastError || new Error('No API endpoint responded.');
}

/* ---------------- overview ---------------- */

function deriveAlerts(payload) {
  const alerts = [];
  const homeopsData = payload.homeops?.data || {};
  const haData = payload.homeassistant?.data || {};
  const devices = toArray(homeopsData.devices);
  const unhealthy = devices.filter((device) => !device.healthy);

  for (const device of unhealthy) {
    const key = `device:${device.name}`;
    if (state.silenced[key]) continue;
    const closed = toArray(device.tcp).filter((port) => !port.open).map((port) => port.port);
    alerts.push({
      key,
      tone: 'bad',
      sev: 'Attention',
      meta: `${device.name} - ${formatTime(payload.homeops?.generatedAt)}`,
      title: closed.length
        ? `${device.name} is not answering on port ${closed.join(', ')}`
        : `${device.name} reported unhealthy`,
      detail: `${device.host || 'host'} - ${device.role || 'system'}. Checked on the last LAN inventory sweep.`,
      primaryLabel: 'Run HomeOps check',
      primary: () => sendCommand({ action: 'homeops.check', text: `Recheck ${device.name}` })
    });
  }

  if (Number(haData.lowBatteryCount || 0) > 0 && !state.silenced.battery) {
    const count = Number(haData.lowBatteryCount);
    alerts.push({
      key: 'battery',
      tone: 'warn',
      sev: 'Watch',
      meta: `Home Assistant - ${formatTime(payload.homeassistant?.generatedAt)}`,
      title: `${count} sensor${count === 1 ? ' is' : 's are'} low on battery`,
      detail: count === 1
        ? 'It has not dropped off yet. Replacing it now avoids an unavailable entity later.'
        : 'None have dropped off yet. Replacing them now avoids an unavailable entity later.',
      primaryLabel: 'See entities',
      primary: () => setScreen('ha')
    });
  }

  if (Number(haData.unavailableOrUnknownCount || 0) > 0 && !state.silenced.unavailable) {
    const count = Number(haData.unavailableOrUnknownCount);
    alerts.push({
      key: 'unavailable',
      tone: 'warn',
      sev: 'Watch',
      meta: `Home Assistant - ${formatTime(payload.homeassistant?.generatedAt)}`,
      title: `${count} entit${count === 1 ? 'y is' : 'ies are'} not reporting`,
      detail: 'Unavailable or unknown since the last monitor run.',
      primaryLabel: 'See entities',
      primary: () => setScreen('ha')
    });
  }

  return alerts;
}

function renderVerdict(payload, alerts) {
  const homeopsData = payload.homeops?.data || {};
  const devices = toArray(homeopsData.devices);
  const unhealthy = devices.filter((device) => !device.healthy);
  const bad = alerts.filter((alert) => alert.tone === 'bad');

  let tone = 'good';
  let headline = 'Everything is answering.';
  let sub = devices.length === 1
    ? 'The one system on record reported healthy on the last sweep.'
    : `All ${devices.length || 0} systems reported healthy on the last sweep.`;

  if (bad.length) {
    tone = 'bad';
    headline = bad.length === 1 ? 'One system needs a look.' : `${bad.length} systems need a look.`;
    sub = bad[0].detail;
  }else if (alerts.length) {
    tone = 'warn';
    headline = 'Nothing is down, but something is drifting.';
    sub = alerts[0].title;
  } else if (!devices.length) {
    tone = 'warn';
    headline = 'No report loaded yet.';
    sub = 'Run a HomeOps check or refresh to pull the latest sweep.';
  }

  els.verdictBar.style.background = tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--good)';
  els.verdictHeadline.textContent = headline;
  els.verdictSub.textContent = sub;
  els.systemsHeadline.textContent = unhealthy.length
    ? `${unhealthy.length} of ${devices.length} system${devices.length === 1 ? '' : 's'} ${unhealthy.length === 1 ? 'needs' : 'need'} a look.`
    : 'All systems healthy.';
}

function renderAlerts(alerts) {
  els.alertList.replaceChildren();
  els.navBadgeOverview.textContent = alerts.length ? String(alerts.length) : '';

  if (!alerts.length) {
    const empty = el('div', 'empty-card');
    empty.append(el('span', 'dot good'), el('span', null, 'Nothing is asking for attention.'));
    els.alertList.appendChild(empty);
    return;
  }

  for (const alert of alerts) {
    const card = el('article', 'card alert');
    const bar = el('span', 'alert-bar');
    bar.style.background = alert.tone === 'bad' ? 'var(--bad)' : 'var(--warn)';
    const body = el('div', 'alert-body');

    const meta = el('div', 'alert-meta');
    const sev = el('span', `sev text-${alert.tone}`, alert.sev);
    meta.append(sev, el('span', 'subtle', alert.meta));

    const actions = el('div', 'button-row');
    const primary = el('button', 'primary', alert.primaryLabel);
    primary.type = 'button';
    primary.addEventListener('click', alert.primary);
    const silenceButton = el('button', null, 'Silence 24 h');
    silenceButton.type = 'button';
    silenceButton.addEventListener('click', () => silence(alert.key));
    actions.append(primary, silenceButton);

    body.append(meta, el('h3', null, alert.title), el('p', null, alert.detail), actions);
    card.append(bar, body);
    els.alertList.appendChild(card);
  }
}

function renderQuiet(payload, alerts) {
  const homeopsData = payload.homeops?.data || {};
  const haData = payload.homeassistant?.data || {};
  const devices = toArray(homeopsData.devices);
  const unhealthy = devices.filter((device) => !device.healthy).length;
  const commandCount = Number(els.activityCount.textContent || 0);

  const rows = [
    {
      screen: 'systems',
      label: 'Systems',
      detail: `${devices.length - unhealthy} of ${devices.length} healthy`,
      tone: unhealthy ? 'warn' : 'good'
    },
    {
      screen: 'ha',
      label: 'Home Assistant',
      detail: `${haData.entityCount ?? '-'} entities - ${haData.unavailableOrUnknownCount ?? '-'} unavailable`,
      tone: Number(haData.unavailableOrUnknownCount || 0) ? 'warn' : 'good'
    },
    { screen: 'activity', label: 'Activity', detail: `${commandCount} actions logged`, tone: 'good' },
    { screen: 'connection', label: 'Connection', detail: normalizeUrl(state.apiUrl).replace(/^https?:\/\//, ''), tone: 'good' }
  ];

  els.quietList.replaceChildren();
  for (const row of rows) {
    const button = el('button', 'quiet-row');
    button.type = 'button';
    const text = el('span', 'quiet-text');
    text.append(el('span', 'quiet-label', row.label), el('span', 'quiet-detail', row.detail));
    button.append(el('span', `dot ${row.tone}`), text, el('span', 'chev', '>'));
    button.addEventListener('click', () => setScreen(row.screen));
    els.quietList.appendChild(button);
  }
}

/* ---------------- systems ---------------- */

function renderSystems(homeops) {
  const devices = toArray(homeops?.data?.devices);
  els.systemsList.replaceChildren();
  els.navBadgeSystems.textContent = '';

  if (!devices.length) {
    els.systemsList.appendChild(el('p', 'subtle', 'No systems loaded'));
    return;
  }

  const unhealthy = devices.filter((device) => !device.healthy).length;
  if (unhealthy) els.navBadgeSystems.textContent = String(unhealthy);

  for (const device of devices) {
    const row = els.systemRowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector('.dot').className = `dot lg ${device.healthy ? 'good' : 'bad'}`;
    row.querySelector('.system-name').textContent = device.name || 'device';
    row.querySelector('.system-host').textContent = `${device.host || '-'} - ${device.role || 'system'}`;
    const status = row.querySelector('.system-status');
    status.textContent = device.healthy ? 'healthy' : 'attention';
    status.className = `system-status ${device.healthy ? 'text-good' : 'text-bad'}`;

    const ports = row.querySelector('.port-list');
    for (const tcp of toArray(device.tcp)) {
      ports.appendChild(el('span', `port ${tcp.open ? '' : 'closed'}`, `${tcp.port} ${tcp.open ? 'open' : 'closed'}`));
    }
    els.systemsList.appendChild(row);
  }
}

/* ---------------- home assistant ---------------- */

function renderHomeAssistant(homeassistant) {
  const data = homeassistant?.data || {};
  els.haEntities.textContent = data.entityCount ?? '-';
  els.haUnavailable.textContent = data.unavailableOrUnknownCount ?? '-';
  els.batteryState.textContent = data.lowBatteryCount ?? '-';
  els.haServices.textContent = data.serviceDomainCount ?? '-';
  els.lastHaRun.textContent = formatTime(homeassistant?.generatedAt);

  const unavailable = Number(data.unavailableOrUnknownCount || 0);
  els.haHeadline.textContent = unavailable
    ? `${unavailable} entit${unavailable === 1 ? 'y is' : 'ies are'} not reporting.`
    : 'Every entity is reporting.';
  els.haSub.textContent = `Home Assistant ${data.version || '-'} is ${(data.apiMessage || 'unknown').toLowerCase()} and serving ${data.serviceDomainCount ?? '-'} service domains.`;
  els.navBadgeHa.textContent = unavailable ? String(unavailable) : '';

  const problemStates = toArray(data.unavailableOrUnknown).slice(0, 20);
  els.haFindings.replaceChildren();
  if (!problemStates.length) {
    els.haFindings.appendChild(el('p', 'subtle', 'No unavailable or unknown entities in the latest report.'));
    return;
  }

  for (const item of problemStates) {
    const row = el('div', 'line-row');
    const friendly = item.attributes?.friendly_name || item.entity_id;
    const bad = item.state === 'unavailable';
    row.append(
      el('span', `dot ${bad ? 'bad' : 'warn'}`),
      el('span', 'line-name', friendly),
      el('span', 'line-meta', item.entity_id),
      el('span', `line-state ${bad ? 'text-bad' : 'text-warn'}`, item.state)
    );
    els.haFindings.appendChild(row);
  }
}

/* ---------------- plex duplicates ---------------- */

function plexRowMatchesFilter(row, filter) {
  const action = row.decision?.action || 'pending';
  if (filter === 'all') return true;
  if (filter === 'pending') return !row.decision?.action;
  if (filter === 'manual-review') return String(row.confidence || '').startsWith('manual-review');
  return action === filter;
}

function filePane(kind, label, quality, files) {
  const pane = el('div', `file-pane ${kind}`);
  pane.append(el('span', 'file-label', label), el('div', 'file-quality', quality || '-'));
  const list = toArray(files);
  if (!list.length) pane.append(el('code', null, '-'));
  for (const file of list) {
    const code = el('code', null, file);
    code.title = file;
    pane.append(code);
  }
  return pane;
}

function renderPlexDuplicates(report) {
  const summary = report?.summary || {};
  const rows = toArray(report?.rows);
  const visibleRows = rows.filter((row) => plexRowMatchesFilter(row, state.plexDuplicateFilter));
  const approvedCount = Number(summary.approvedRows || rows.filter((row) => ['approved', 'swapped'].includes(row.decision?.action)).length || 0);
  const swappedCount = Number(summary.swappedRows || rows.filter((row) => row.decision?.action === 'swapped').length || 0);
  const pendingCount = rows.filter((row) => !row.decision?.action).length;

  els.plexDupState.textContent = summary.duplicateGroups ?? '-';
  els.plexDupHeadline.textContent = pendingCount
    ? `${pendingCount} duplicate group${pendingCount === 1 ? '' : 's'} still to judge.`
    : rows.length ? 'Every duplicate has a decision.' : 'No duplicate report loaded.';
  els.plexDupMeta.textContent = report
    ? `${summary.removeCandidates ?? '-'} remove candidates - scanned ${formatTime(report.generatedAt)} - report only, nothing moved`
    : 'Run a scan to build one.';
  els.plexHeadline.textContent = els.plexDupHeadline.textContent;
  els.navBadgePlex.textContent = pendingCount ? String(pendingCount) : '';

  els.plexApprovalState.textContent = approvedCount
    ? `${approvedCount} row${approvedCount === 1 ? '' : 's'} staged${swappedCount ? `, including ${swappedCount} swapped` : ''}`
    : 'Nothing staged yet';
  els.plexStagedDetail.textContent = approvedCount
    ? 'Files move to quarantine, then Plex rescans.'
    : 'Approve or swap a row to stage it.';

  els.previewPlexDuplicates.disabled = state.busy || !report?.path || approvedCount === 0;
  els.approvePlexDuplicates.disabled = state.busy || !report?.path || approvedCount === 0;
  els.plexDupVisible.textContent = rows.length ? `showing ${visibleRows.length} of ${rows.length}` : '-';

  for (const chip of document.querySelectorAll('.chip')) {
    const filter = chip.dataset.filter;
    chip.classList.toggle('active', filter === state.plexDuplicateFilter);
    const count = filter === 'all' ? rows.length
      : filter === 'pending' ? pendingCount
      : filter === 'manual-review' ? rows.filter((row) => String(row.confidence || '').startsWith('manual-review')).length
      : rows.filter((row) => row.decision?.action === filter).length;
    chip.textContent = `${filter === 'manual-review' ? 'manual review' : filter} ${count}`;
  }

  const displayPlan = report?.cleanupPlan || state.plexCleanupPreview;
  renderPlexCleanupPlan(displayPlan);
  if (isCleanupRunning(report?.cleanupPlan)) startCleanupProgressPolling();
  else stopCleanupProgressPolling();

  els.plexDupList.replaceChildren();
  if (!rows.length) {
    els.plexDupList.appendChild(el('p', 'subtle', report ? 'No duplicate movie candidates in the latest report.' : 'No Plex duplicate report loaded.'));
    return;
  }
  if (!visibleRows.length) {
    els.plexDupList.appendChild(el('p', 'subtle', 'No rows match this filter.'));
    return;
  }

  for (const row of visibleRows) {
    const action = row.decision?.action || '';
    const swapped = action === 'swapped';
    const item = el('article', `duplicate-row ${action ? `decision-${action}` : ''}`);
    item.dataset.rowId = row.rowId || '';
    if (state.busyRows.has(row.rowId)) item.classList.add('row-busy');

    const head = el('div', 'duplicate-head');
    head.append(el('span', 'duplicate-title', row.title || 'Untitled'));
    if (row.year) head.append(el('span', 'duplicate-year', row.year));
    if (String(row.confidence || '').startsWith('manual-review')) head.append(el('span', 'tag', 'manual review'));
    head.append(el('span', `decision-state ${action || 'pending'}`, action || 'pending'));

    const files = el('div', 'duplicate-files');
    files.append(
      filePane('keep', swapped ? 'Keep after swap' : 'Keep',
        swapped ? row.candidateQuality : row.keepQuality,
        swapped ? row.cleanupKeepFiles : row.keepFiles),
      filePane('remove', swapped ? 'Remove after swap' : 'Remove candidate',
        swapped ? row.keepQuality : row.candidateQuality,
        swapped ? row.cleanupCandidateFiles : row.candidateFiles)
    );

    const actions = el('div', 'duplicate-actions');
    const decisionButton = (label, next, reason, isActive) => {
      const button = el('button', `secondary ${isActive ? 'selected' : ''}`, label);
      button.type = 'button';
      button.disabled = state.busyRows.has(row.rowId);
      button.addEventListener('click', () => setPlexDuplicateDecision(row.rowId, next, reason));
      return button;
    };
    actions.append(
      decisionButton('Approve', 'approved', '', action === 'approved'),
      decisionButton('Swap keep', 'swapped', 'swap_keep_candidate', swapped),
      decisionButton('Ignore', 'ignored', 'not_same_movie', action === 'ignored')
    );
    if (action) {
      const clear = el('button', null, 'Clear');
      clear.type = 'button';
      clear.addEventListener('click', () => setPlexDuplicateDecision(row.rowId, 'clear'));
      actions.append(clear);
    }
    if (row.reason) actions.append(el('span', 'duplicate-reason', row.reason));

    item.append(head, files, actions);
    els.plexDupList.appendChild(item);
  }
}

function setLatestPlexReport(report) {
  if (state.lastStatus && report) state.lastStatus.plexDuplicates = report;
}

function renderLatestPlexReport() {
  if (state.lastStatus?.plexDuplicates) renderPlexDuplicates(state.lastStatus.plexDuplicates);
}

function renderPlexCleanupPlan(plan) {
  els.plexCleanupPlan.replaceChildren();
  if (!plan?.planId) return;
  const progress = state.cleanupProgress?.planId === plan.planId ? state.cleanupProgress : null;

  const head = el('div', 'plan-head');
  head.append(el('span', 'plan-id', plan.planId),
    el('span', 'subtle', `${plan.moveCount || 0} files - ${String(plan.status || 'planned').split('_').join(' ')} - ${formatTime(plan.createdAt)}`));

  const rail = el('div', 'stage-rail');
  for (const stage of toArray(plan.stages)) {
    const status = stage.status || 'pending';
    const mark = status === 'complete' ? 'OK' : status === 'running' ? '..' : status === 'blocked' ? '!' : '-';
    const chip = el('span', `stage-chip ${status}`);
    chip.append(el('span', null, mark), el('span', null, stage.label || stage.id || 'stage'));
    rail.appendChild(chip);
  }

  els.plexCleanupPlan.append(head, rail);

  if (progress || plan.status === 'running') {
    const current = Number(progress?.current || 0);
    const total = Number(progress?.total || plan.moveCount || 0);
    const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
    const block = el('div');
    const message = progress?.message || 'Quarantine in progress.';
    block.append(el('div', 'progress-label', total > 0 ? `${message} ${current} of ${total} files (${percent}%).` : message));
    const track = el('div', 'progress-track');
    const fill = el('div', 'progress-fill');
    fill.style.width = `${percent}%`;
    track.appendChild(fill);
    block.appendChild(track);
    els.plexCleanupPlan.appendChild(block);
  }

  const verificationItems = toArray(plan.verificationItems);
  const verificationSummary = plan.verificationSummary || {};
  const verifiedCount = Number(verificationSummary.verified ?? verificationItems.filter((item) => item.verified).length);
  const issueCount = Number(verificationSummary.issues ?? verificationItems.filter((item) => item.status === 'issue').length);
  const restoredCount = Number(verificationSummary.restored ?? verificationItems.filter((item) => item.status === 'restored').length);
  const resolvedCount = Number(verificationSummary.resolved ?? (verifiedCount + issueCount + restoredCount));
  const totalVerifyCount = Number(verificationSummary.total ?? verificationItems.length);
  const allItemsResolved = totalVerifyCount > 0 && resolvedCount === totalVerifyCount;

  const stageStatus = (id) => toArray(plan.stages).find((stage) => stage.id === id)?.status;
  const canVerifyItems = stageStatus('verification') === 'pending'
    && stageStatus('quarantine') === 'complete'
    && stageStatus('plex_rescan') === 'complete';

  const folderCleanup = plan.sourceFolderCleanup || {};
  const sourceFolders = toArray(plan.sourceFolders);
  if (sourceFolders.length || folderCleanup.removed?.length || folderCleanup.kept?.length) {
    const block = el('div', 'source-folders');
    const folderHead = el('div', 'verify-head');
    folderHead.append(el('span', 'section-label', 'Removed file source folders'),
      el('span', 'subtle', folderCleanup.removed?.length ? `${folderCleanup.removed.length} removed` : `${sourceFolders.length} listed`));
    block.appendChild(folderHead);
    const values = [
      ...toArray(folderCleanup.removed).map((folder) => `REMOVED ${folder}`),
      ...toArray(folderCleanup.kept).map((folder) => `KEPT ${folder}`),
      ...toArray(folderCleanup.skipped).map((folder) => `SKIPPED ${folder}`),
      ...toArray(folderCleanup.alreadyMissing).map((folder) => `MISSING ${folder}`)
    ];
    for (const folder of (values.length ? values : sourceFolders)) block.append(el('code', null, folder));
    els.plexCleanupPlan.appendChild(block);
  }

  if (plan.status === 'deleted') {
    const finalDelete = plan.finalDeleteSummary || {};
    els.plexCleanupPlan.appendChild(el('div', 'plan-complete',
      `Final delete completed. ${verificationSummary.resolved ?? verifiedCount} of ${verificationSummary.total ?? plan.moveCount ?? 0} cleanup items resolved. ${finalDelete.deletedFileCount ?? 0} files and ${finalDelete.deletedFolderCount ?? 0} folders deleted.`));

    if (finalDelete.deletedFileCount || finalDelete.deletedFolderCount || finalDelete.keptFolderCount) {
      const reportActions = el('div', 'button-row');
      reportActions.style.marginTop = '14px';
      const openReport = (type) => {
        const params = new URLSearchParams({ type, planId: plan.planId });
        window.open(`/final-delete-report.html?${params.toString()}`, '_blank', 'noopener');
      };
      const filesButton = el('button', 'secondary', `Deleted files (${finalDelete.deletedFileCount || 0})`);
      filesButton.type = 'button';
      filesButton.addEventListener('click', () => openReport('files'));
      const foldersButton = el('button', 'secondary', `Folder results (${(finalDelete.deletedFolderCount || 0) + (finalDelete.keptFolderCount || 0)})`);
      foldersButton.type = 'button';
      foldersButton.addEventListener('click', () => openReport('folders'));
      reportActions.append(filesButton, foldersButton);
      els.plexCleanupPlan.appendChild(reportActions);
    }
    return;
  }

  if (verificationItems.length) {
    const verifyHead = el('div', 'verify-head');
    verifyHead.append(el('span', 'section-label', 'Playback check'),
      el('span', 'subtle', `${resolvedCount} of ${totalVerifyCount} resolved${issueCount ? `, ${issueCount} issue${issueCount === 1 ? '' : 's'}` : ''}${restoredCount ? `, ${restoredCount} restored` : ''}`));
    els.plexCleanupPlan.appendChild(verifyHead);

    const list = el('div', 'verify-list');
    for (const item of verificationItems) {
      const status = item.status || (item.verified ? 'verified' : 'pending');
      const row = el('div', `verify-item ${status}`);
      const statusText = status === 'issue' ? 'restore needed' : status;
      const choices = el('div', 'verify-actions');

      const verifiedChoice = el('label', `verify-choice ${status === 'verified' ? 'selected' : ''}`);
      const verifiedInput = el('input');
      verifiedInput.type = 'checkbox';
      verifiedInput.checked = status === 'verified';
      verifiedInput.disabled = state.busy || !canVerifyItems || status === 'restored';
      verifiedInput.addEventListener('change', () => setPlexPlaybackVerificationItem(plan, item, verifiedInput.checked));
      verifiedChoice.title = 'Approve this duplicate for removal during final cleanup.';
      verifiedChoice.append(verifiedInput, el('span', null, 'Verified'));

      const issueChoice = el('label', `verify-choice issue-choice ${status === 'issue' ? 'selected' : ''}`);
      const issueInput = el('input');
      issueInput.type = 'checkbox';
      issueInput.checked = status === 'issue';
      issueInput.disabled = state.busy || !canVerifyItems || status === 'restored';
      issueInput.addEventListener('change', () => markPlexPlaybackIssue(plan, item, issueInput.checked));
      issueChoice.title = 'Mark this movie for original restore during final cleanup.';
      issueChoice.append(issueInput, el('span', null, 'Issue'));

      choices.append(verifiedChoice, issueChoice);

      row.append(el('span', 'verify-title', item.title || 'Untitled'), el('span', 'verify-state', statusText), choices);
      if (item.issueNote) row.append(el('span', 'verify-note text-warn', item.issueNote));
      list.appendChild(row);
    }
    els.plexCleanupPlan.appendChild(list);
  }

  const gate = el('div', 'plan-gate');
  const verificationComplete = stageStatus('verification') === 'complete';
  const priorComplete = stageStatus('quarantine') === 'complete' && stageStatus('plex_rescan') === 'complete';

  if (!verificationComplete) {
    gate.append(el('span', null, allItemsResolved
      ? 'Every movie is resolved. Final cleanup will restore issue-marked movies and delete approved duplicates.'
      : 'Choose Verified or Issue for every movie before final cleanup unlocks.'));
    const finalButton = el('button', 'danger', allItemsResolved ? 'Apply deletes/restores' : `Resolve all movies (${resolvedCount}/${totalVerifyCount})`);
    finalButton.type = 'button';
    finalButton.disabled = state.busy || !canVerifyItems || !allItemsResolved || Boolean(plan.finalDeleteApproval);
    finalButton.addEventListener('click', () => recordFinalDeleteApproval(plan));
    gate.append(finalButton);
  } else {
    gate.append(el('span', null, plan.finalDeleteApproval
      ? 'Final cleanup already approved for this plan.'
      : 'Final cleanup is unlocked and gated by a typed confirmation.'));
    const finalButton = el('button', 'danger', plan.finalDeleteApproval ? 'Cleanup approved' : 'Apply deletes/restores');
    finalButton.type = 'button';
    finalButton.disabled = state.busy || Boolean(plan.finalDeleteApproval) || !priorComplete;
    finalButton.addEventListener('click', () => recordFinalDeleteApproval(plan));
    gate.append(finalButton);
  }
  els.plexCleanupPlan.appendChild(gate);
}

function isCleanupRunning(plan) {
  return plan?.status === 'running' || toArray(plan?.stages).some((stage) => stage.status === 'running');
}

async function refreshCleanupProgress() {
  try {
    const payload = await apiFetch('/api/plex/duplicates/progress');
    state.cleanupProgress = payload.progress || null;
    const plan = state.lastStatus?.plexDuplicates?.cleanupPlan;
    if (state.cleanupProgress?.planId && state.cleanupProgress.planId !== plan?.planId) {
      const status = await loadStatusWithFallbacks();
      renderStatus(status);
    } else if (plan?.planId) {
      if (state.cleanupProgress?.status === 'running') {
        plan.status = 'running';
        if (toArray(state.cleanupProgress.stages).length) plan.stages = state.cleanupProgress.stages;
      }
      if (state.cleanupProgress?.status === 'complete') {
        plan.status = 'awaiting_playback_verification';
        if (toArray(state.cleanupProgress.stages).length) plan.stages = state.cleanupProgress.stages;
      }
      renderPlexCleanupPlan(plan);
    }
    if (state.cleanupProgress?.status === 'running') {
      const current = Number(state.cleanupProgress.current || 0);
      const total = Number(state.cleanupProgress.total || 0);
      els.commandState.textContent = total > 0
        ? `Quarantining ${current} of ${total} files`
        : state.cleanupProgress.message || 'Quarantining';
    }
    return state.cleanupProgress;
  } catch (error) {
    els.commandState.textContent = error.message;
    return null;
  }
}

function startCleanupProgressPolling() {
  if (state.cleanupProgressTimer) return;
  refreshCleanupProgress();
  state.cleanupProgressTimer = window.setInterval(refreshCleanupProgress, 5000);
}

function stopCleanupProgressPolling() {
  if (!state.cleanupProgressTimer) return;
  window.clearInterval(state.cleanupProgressTimer);
  state.cleanupProgressTimer = null;
}

/* ---------------- activity ---------------- */

function renderActions(actions) {
  const quick = toArray(actions).filter((action) => {
    return ['homeops.check', 'homeassistant.monitor', 'lan.inventory', 'plex.duplicates.scan'].includes(action.id);
  });
  els.quickActions.replaceChildren();
  for (const action of quick) {
    const button = el('button', 'secondary', action.label);
    button.type = 'button';
    button.dataset.action = action.id;
    button.addEventListener('click', () => sendCommand({ action: action.id, text: action.label }));
    els.quickActions.appendChild(button);
  }
}

function renderActivity(commands) {
  const rows = toArray(commands).reverse();
  els.activityCount.textContent = String(rows.length);
  els.activityList.replaceChildren();

  if (!rows.length) {
    els.activityList.appendChild(el('li', 'subtle', 'No command activity yet'));
    return;
  }

  for (const command of rows) {
    const item = el('li', 'activity-item');
    const head = el('div', 'activity-head');
    const ok = String(command.status || '').toLowerCase() === 'success';
    head.append(
      el('span', `dot ${ok ? 'good' : 'bad'}`),
      el('span', 'activity-action', command.action || 'message'),
      el('span', `activity-status ${ok ? 'text-good' : 'text-bad'}`, command.status || 'unknown'),
      el('span', 'activity-when', `${formatTime(command.receivedAt)} - ${command.remoteAddress || '-'}`)
    );
    item.append(head);
    const output = command.error || command.result?.output || command.text || '';
    if (output) item.append(el('code', null, output));
    els.activityList.appendChild(item);
  }
}

function renderEndpoints() {
  const seen = [];
  for (const url of [state.apiUrl, ...API_FALLBACK_URLS].map(normalizeUrl).filter(Boolean)) {
    if (seen.includes(url)) continue;
    seen.push(url);
  }
  els.endpointList.replaceChildren();
  for (const url of seen) {
    const status = url === normalizeUrl(state.apiUrl) ? 'in use' : (state.endpointStates[url] || 'not tried');
    const tone = status === 'in use' ? 'good' : status === 'no answer' ? '' : 'warn';
    const row = el('div', 'line-row');
    row.append(
      el('span', `dot ${tone}`),
      el('span', 'line-name', url),
      el('span', `line-state ${status === 'in use' ? 'text-good' : 'text-muted'}`, status)
    );
    els.endpointList.appendChild(row);
  }
}

/* ---------------- status ---------------- */

function renderStatus(payload) {
  state.lastStatus = payload;
  const server = payload.server || {};
  els.serverLine.textContent = server.computer || 'Control PC';
  els.lastHomeopsRun.textContent = `reports from ${formatTime(payload.homeops?.generatedAt)}`;

  const alerts = deriveAlerts(payload);
  renderVerdict(payload, alerts);
  renderAlerts(alerts);
  renderActions(payload.actions);
  renderSystems(payload.homeops);
  renderHomeAssistant(payload.homeassistant);
  renderPlexDuplicates(payload.plexDuplicates);
  renderQuiet(payload, alerts);
  renderEndpoints();
}

async function loadStatus() {
  if (!state.token) {
    setConnection('No token saved', 'warn');
    els.commandState.textContent = 'Token required';
    setScreen('connection');
    return;
  }

  try {
    const payload = await loadStatusWithFallbacks();
    renderStatus(payload);
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    renderQuiet(payload, deriveAlerts(payload));
    setConnection('Online', 'good');
  } catch (error) {
    setConnection('Offline', 'bad');
    els.commandState.textContent = error.message;
  }
}

/* ---------------- commands ---------------- */

async function refreshAfter(payload) {
  if (payload?.status) renderStatus(payload.status);
  const history = await apiFetch('/api/commands');
  renderActivity(history.commands);
  if (state.lastStatus) renderQuiet(state.lastStatus, deriveAlerts(state.lastStatus));
}

async function sendCommand(command) {
  if (state.busy) return;
  setBusy(true, `Running ${command.action || 'message'}`);
  try {
    const payload = await apiFetch('/api/commands', { method: 'POST', body: JSON.stringify(command) });
    await refreshAfter(payload);
    els.commandText.value = '';
    setConnection('Online', 'good');
    toast(`${command.action || 'message'} finished.`);
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function setPlexDuplicateDecision(rowId, action, reason = '') {
  if (!rowId || state.busyRows.has(rowId)) return;
  setRowBusy(rowId, true);
  els.commandState.textContent = action === 'clear' ? 'Clearing' : `Marking ${action}`;
  try {
    const payload = await apiFetch('/api/plex/duplicates/decision', {
      method: 'POST',
      body: JSON.stringify({ rowId, action, reason })
    });
    state.plexCleanupPreview = null;
    setLatestPlexReport(payload.report);
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    els.commandState.textContent = 'Idle';
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
    toast(error.message);
  } finally {
    setRowBusy(rowId, false);
    renderLatestPlexReport();
  }
}

async function previewPlexCleanupPlan() {
  const report = state.lastStatus?.plexDuplicates;
  if (state.busy || !report?.path) return;
  setBusy(true, 'Previewing');
  try {
    const payload = await apiFetch('/api/plex/duplicates/cleanup-preview', {
      method: 'POST',
      body: JSON.stringify({ reportPath: report.path })
    });
    state.plexCleanupPreview = payload.plan || null;
    setLatestPlexReport(payload.report);
    setConnection('Online', 'good');
    toast(`Previewed ${payload.plan?.moveCount || 0} quarantine move${payload.plan?.moveCount === 1 ? '' : 's'}.`);
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
    renderLatestPlexReport();
  }
}

async function finalizePlexCleanupPlan() {
  const report = state.lastStatus?.plexDuplicates;
  if (state.busy || !report?.path) return;

  const staged = toArray(report.rows).filter((row) => ['approved', 'swapped'].includes(row.decision?.action));
  const ok = await openConfirm({
    title: 'Move staged files to quarantine',
    body: `${staged.length} file${staged.length === 1 ? '' : 's'} move to the quarantine folder, then Plex rescans. Source folders are removed only when they sit under the Plex media tree and hold no other movie files. Nothing is deleted at this step.`,
    rows: staged.map((row) => ({
      title: row.title || 'Untitled',
      path: toArray(row.decision?.action === 'swapped' ? row.cleanupCandidateFiles : row.candidateFiles)[0] || ''
    })),
    word: 'QUARANTINE',
    goLabel: 'Quarantine and rescan'
  });
  if (!ok) return;

  setBusy(true, 'Quarantining');
  startCleanupProgressPolling();
  try {
    const payload = await apiFetch('/api/plex/duplicates/finalize-cleanup', {
      method: 'POST',
      body: JSON.stringify({ reportPath: report.path, confirm: 'QUARANTINE' })
    });
    state.plexCleanupPreview = null;
    setLatestPlexReport(payload.report);
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    toast(`Quarantined and rescanned: ${payload.plan?.planId || ''}`);
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
    toast(error.message);
  } finally {
    await refreshCleanupProgress();
    stopCleanupProgressPolling();
    setBusy(false);
    renderLatestPlexReport();
  }
}

async function setPlexPlaybackVerificationItem(plan, item, verified) {
  if (state.busy || !plan?.planId || !item?.key) return;
  setBusy(true, verified ? 'Marking verified' : 'Clearing');
  try {
    const payload = await apiFetch('/api/plex/duplicates/verification-item', {
      method: 'POST',
      body: JSON.stringify({ planId: plan.planId, key: item.key, verified })
    });
    setLatestPlexReport(payload.report);
    const summary = payload.report?.cleanupPlan?.verificationSummary;
    els.commandState.textContent = summary
      ? `Playback checks: ${summary.resolved ?? summary.verified} of ${summary.total} resolved`
      : 'Playback check updated';
    setConnection('Online', 'good');
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
    renderLatestPlexReport();
  }
}

async function markPlexPlaybackIssue(plan, item, issue) {
  if (state.busy || !plan?.planId || !item?.key) return;
  setBusy(true, issue ? 'Marking issue' : 'Clearing issue');
  try {
    const payload = await apiFetch('/api/plex/duplicates/verification-issue', {
      method: 'POST',
      body: JSON.stringify({
        planId: plan.planId,
        key: item.key,
        issue,
        note: 'Restore original during final cleanup.'
      })
    });
    setLatestPlexReport(payload.report);
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    toast(issue ? 'Movie marked for restore.' : 'Restore mark cleared.');
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
    renderLatestPlexReport();
  }
}

async function recordFinalDeleteApproval(plan) {
  if (state.busy || !plan?.planId || plan.finalDeleteApproval) return;
  const summary = plan.verificationSummary || {};
  const issueCount = Number(summary.issues || 0);
  const ok = await openConfirm({
    title: 'Apply final cleanup',
    body: `This restores ${issueCount} issue-marked movie${issueCount === 1 ? '' : 's'} and permanently deletes the approved quarantined duplicates for ${plan.planId}. There is no undo.`,
    word: 'DELETE',
    goLabel: 'Apply cleanup',
    danger: true
  });
  if (!ok) return;

  setBusy(true, 'Applying cleanup');
  try {
    const payload = await apiFetch('/api/plex/duplicates/final-delete-approval', {
      method: 'POST',
      body: JSON.stringify({ planId: plan.planId, confirm: 'DELETE', verificationComplete: true })
    });
    setLatestPlexReport(payload.report);
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    toast('Final cleanup completed.');
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
    toast(error.message);
  } finally {
    setBusy(false);
    renderLatestPlexReport();
  }
}

function saveSettings() {
  state.apiUrl = normalizeUrl(els.apiUrl.value || window.location.origin);
  state.token = els.apiToken.value.trim();
  localStorage.setItem('homeops.apiUrl', state.apiUrl);
  localStorage.setItem('homeops.token', state.token);
  toast('Saved. Reconnecting...');
  loadStatus();
}

/* ---------------- wiring ---------------- */

els.apiUrl.value = state.apiUrl;
els.apiToken.value = state.token;

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => setScreen(button.dataset.screen));
}
for (const button of document.querySelectorAll('[data-goto]')) {
  button.addEventListener('click', () => setScreen(button.dataset.goto));
}
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.plexDuplicateFilter = chip.dataset.filter || 'all';
    localStorage.setItem('homeops.plexDuplicateFilter', state.plexDuplicateFilter);
    if (state.lastStatus) renderPlexDuplicates(state.lastStatus.plexDuplicates);
  });
}

els.saveSettings.addEventListener('click', saveSettings);
els.refreshStatus.addEventListener('click', loadStatus);
els.refreshStatus2.addEventListener('click', loadStatus);
els.scanPlexDuplicates.addEventListener('click', () => {
  state.plexCleanupPreview = null;
  sendCommand({ action: 'plex.duplicates.scan', text: 'Plex duplicate movie scan' });
});
els.previewPlexDuplicates.addEventListener('click', previewPlexCleanupPlan);
els.approvePlexDuplicates.addEventListener('click', finalizePlexCleanupPlan);
els.queueMessage.addEventListener('click', () => {
  const text = els.commandText.value.trim();
  if (text) sendCommand({ action: 'message', text });
});
els.commandForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.commandText.value.trim();
  if (text) sendCommand({ text });
});

if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}

setScreen(state.screen);
renderEndpoints();
loadStatus();
