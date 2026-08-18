const launchSettings = getLaunchSettings();

const state = {
  apiUrl: launchSettings.apiUrl || localStorage.getItem('homeops.apiUrl') || window.location.origin,
  token: launchSettings.token || localStorage.getItem('homeops.token') || '',
  busy: false,
  lastStatus: null,
  plexDuplicateFilter: localStorage.getItem('homeops.plexDuplicateFilter') || 'all',
  plexCleanupPreview: null,
  cleanupProgress: null,
  cleanupProgressTimer: null
};

if (launchSettings.apiUrl) {
  localStorage.setItem('homeops.apiUrl', launchSettings.apiUrl);
}
if (launchSettings.token) {
  localStorage.setItem('homeops.token', launchSettings.token);
}

const API_FALLBACK_URLS = [
  window.location.origin,
  'https://kevin-pc.taile05f72.ts.net',
  'http://kevin-pc.taile05f72.ts.net:8080',
  'http://100.97.88.6:8787',
  'http://192.168.1.86:8787'
];

const els = {
  apiUrl: document.getElementById('apiUrl'),
  apiToken: document.getElementById('apiToken'),
  saveSettings: document.getElementById('saveSettings'),
  refreshStatus: document.getElementById('refreshStatus'),
  connectionPill: document.getElementById('connectionPill'),
  serverLine: document.getElementById('serverLine'),
  networkState: document.getElementById('networkState'),
  networkMeta: document.getElementById('networkMeta'),
  haState: document.getElementById('haState'),
  haMeta: document.getElementById('haMeta'),
  batteryState: document.getElementById('batteryState'),
  batteryMeta: document.getElementById('batteryMeta'),
  plexDupState: document.getElementById('plexDupState'),
  plexDupMeta: document.getElementById('plexDupMeta'),
  systemsList: document.getElementById('systemsList'),
  lastHomeopsRun: document.getElementById('lastHomeopsRun'),
  lastHaRun: document.getElementById('lastHaRun'),
  haVersion: document.getElementById('haVersion'),
  haEntities: document.getElementById('haEntities'),
  haUnavailable: document.getElementById('haUnavailable'),
  haServices: document.getElementById('haServices'),
  haFindings: document.getElementById('haFindings'),
  quickActions: document.getElementById('quickActions'),
  commandForm: document.getElementById('commandForm'),
  commandText: document.getElementById('commandText'),
  sendCommand: document.getElementById('sendCommand'),
  queueMessage: document.getElementById('queueMessage'),
  commandState: document.getElementById('commandState'),
  scanPlexDuplicates: document.getElementById('scanPlexDuplicates'),
  previewPlexDuplicates: document.getElementById('previewPlexDuplicates'),
  approvePlexDuplicates: document.getElementById('approvePlexDuplicates'),
  plexDupFilter: document.getElementById('plexDupFilter'),
  plexDupVisible: document.getElementById('plexDupVisible'),
  plexDupRun: document.getElementById('plexDupRun'),
  plexDupGroups: document.getElementById('plexDupGroups'),
  plexDupCandidates: document.getElementById('plexDupCandidates'),
  plexDupReview: document.getElementById('plexDupReview'),
  plexDupApproved: document.getElementById('plexDupApproved'),
  plexApprovalState: document.getElementById('plexApprovalState'),
  plexCleanupPlan: document.getElementById('plexCleanupPlan'),
  plexDupList: document.getElementById('plexDupList'),
  activityList: document.getElementById('activityList'),
  activityCount: document.getElementById('activityCount'),
  systemRowTemplate: document.getElementById('systemRowTemplate')
};

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

function setConnection(label, tone) {
  els.connectionPill.textContent = label;
  els.connectionPill.className = `pill ${tone || 'neutral'}`;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function statusClass(ok) {
  return ok ? 'state-good' : 'state-bad';
}

async function apiFetch(path, options = {}) {
  const url = `${normalizeUrl(state.apiUrl)}${path}`;
  const headers = Object.assign({}, options.headers || {}, {
    Authorization: `Bearer ${state.token}`
  });
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, Object.assign({}, options, { headers }));
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { ok: false, error: text };
    }
  }
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
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
      els.apiUrl.value = state.apiUrl;
      localStorage.setItem('homeops.apiUrl', state.apiUrl);
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('No API endpoint responded.');
}

function renderActions(actions) {
  const quick = toArray(actions).filter((action) => {
    return ['homeops.check', 'homeassistant.monitor', 'lan.inventory', 'plex.duplicates.scan'].includes(action.id);
  });
  els.quickActions.replaceChildren();
  for (const action of quick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.dataset.action = action.id;
    button.addEventListener('click', () => sendCommand({ action: action.id, text: action.label }));
    els.quickActions.appendChild(button);
  }
}

function renderFileList(files, prefix) {
  const wrap = document.createElement('div');
  wrap.className = 'duplicate-files';
  const label = document.createElement('span');
  label.className = prefix === 'KEEP' ? 'file-label keep-label' : 'file-label remove-label';
  label.textContent = prefix;
  wrap.appendChild(label);
  for (const file of toArray(files)) {
    const code = document.createElement('code');
    code.title = file;
    code.textContent = file;
    wrap.appendChild(code);
  }
  if (!toArray(files).length) {
    const code = document.createElement('code');
    code.textContent = '-';
    wrap.appendChild(code);
  }
  return wrap;
}

function plexRowMatchesFilter(row, filter) {
  const action = row.decision?.action || 'pending';
  if (filter === 'all') return true;
  if (filter === 'pending') return !row.decision?.action;
  if (filter === 'manual-review') return String(row.confidence || '').startsWith('manual-review');
  return action === filter;
}

function renderPlexDuplicates(report) {
  const summary = report?.summary || {};
  const rows = toArray(report?.rows);
  const visibleRows = rows.filter((row) => plexRowMatchesFilter(row, state.plexDuplicateFilter));
  const approvedCount = Number(summary.approvedRows || rows.filter((row) => ['approved', 'swapped'].includes(row.decision?.action)).length || 0);
  const swappedCount = Number(summary.swappedRows || rows.filter((row) => row.decision?.action === 'swapped').length || 0);
  const ignoredCount = Number(summary.ignoredRows || rows.filter((row) => row.decision?.action === 'ignored').length || 0);

  els.plexDupState.textContent = summary.duplicateGroups ?? '-';
  els.plexDupMeta.textContent = report
    ? `${summary.removeCandidates ?? '-'} candidates - ${formatTime(report.generatedAt)}`
    : 'No report loaded';
  els.plexDupRun.textContent = formatTime(report?.generatedAt);
  els.plexDupGroups.textContent = summary.duplicateGroups ?? '-';
  els.plexDupCandidates.textContent = summary.removeCandidates ?? '-';
  els.plexDupReview.textContent = String(approvedCount);
  els.plexDupApproved.textContent = String(ignoredCount);
  els.plexApprovalState.textContent = approvedCount
    ? `${approvedCount} approved row${approvedCount === 1 ? '' : 's'} ready to quarantine and rescan${swappedCount ? `, including ${swappedCount} swapped` : ''}.`
    : 'Approve rows individually, or ignore false matches.';
  els.previewPlexDuplicates.disabled = state.busy || !report?.path || approvedCount === 0;
  els.approvePlexDuplicates.disabled = state.busy || !report?.path || approvedCount === 0;
  els.plexDupFilter.value = state.plexDuplicateFilter;
  els.plexDupVisible.textContent = rows.length
    ? `Showing ${visibleRows.length} of ${rows.length}`
    : '-';
  const displayPlan = report?.cleanupPlan || state.plexCleanupPreview;
  renderPlexCleanupPlan(displayPlan);
  if (isCleanupRunning(report?.cleanupPlan)) {
    startCleanupProgressPolling();
  } else {
    stopCleanupProgressPolling();
  }

  els.plexDupList.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'subtle';
    empty.textContent = report ? 'No duplicate movie candidates in the latest report.' : 'No Plex duplicate report loaded.';
    els.plexDupList.appendChild(empty);
    return;
  }
  if (!visibleRows.length) {
    const empty = document.createElement('p');
    empty.className = 'subtle';
    empty.textContent = 'No rows match this filter.';
    els.plexDupList.appendChild(empty);
    return;
  }

  for (const row of visibleRows) {
    const item = document.createElement('div');
    const decisionAction = row.decision?.action || '';
    item.className = `duplicate-row ${decisionAction ? `decision-${decisionAction}` : ''}`;
    item.dataset.rowId = row.rowId || '';

    const head = document.createElement('div');
    head.className = 'duplicate-head';
    const title = document.createElement('strong');
    title.textContent = row.title || 'Untitled';
    const badge = document.createElement('span');
    badge.className = String(row.confidence || '').startsWith('manual-review') ? 'dupe-badge review' : 'dupe-badge candidate';
    badge.textContent = row.confidence || 'candidate';
    head.append(title, badge);

    const decision = document.createElement('span');
    decision.className = `decision-state ${decisionAction || 'pending'}`;
    decision.textContent = decisionAction === 'swapped' ? 'SWAPPED' : decisionAction ? decisionAction.toUpperCase() : 'PENDING';
    head.append(decision);

    const quality = document.createElement('div');
    quality.className = 'duplicate-quality';
    quality.textContent = decisionAction === 'swapped'
      ? `${row.candidateQuality || '-'} kept after swap; ${row.keepQuality || '-'} removed`
      : `${row.keepQuality || '-'} > ${row.candidateQuality || '-'}`;

    const reason = document.createElement('div');
    reason.className = 'duplicate-reason';
    reason.textContent = row.reason || '';

    const controls = document.createElement('div');
    controls.className = 'duplicate-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve';
    approve.disabled = state.busy || decisionAction === 'approved';
    approve.addEventListener('click', () => setPlexDuplicateDecision(row.rowId, 'approved'));
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'secondary';
    swap.textContent = 'Swap';
    swap.disabled = state.busy || decisionAction === 'swapped';
    swap.addEventListener('click', () => setPlexDuplicateDecision(row.rowId, 'swapped', 'swap_keep_candidate'));
    const ignore = document.createElement('button');
    ignore.type = 'button';
    ignore.className = 'secondary';
    ignore.textContent = 'Ignore';
    ignore.disabled = state.busy || decisionAction === 'ignored';
    ignore.addEventListener('click', () => setPlexDuplicateDecision(row.rowId, 'ignored', 'not_same_movie'));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'secondary';
    clear.textContent = 'Clear';
    clear.disabled = state.busy || !decisionAction;
    clear.addEventListener('click', () => setPlexDuplicateDecision(row.rowId, 'clear'));
    controls.append(approve, swap, ignore, clear);

    const keepLabel = decisionAction === 'swapped' ? 'KEEP AFTER SWAP' : 'KEEP';
    const removeLabel = decisionAction === 'swapped' ? 'REMOVE AFTER SWAP' : 'REMOVE CANDIDATE';
    const keepFiles = decisionAction === 'swapped' ? row.cleanupKeepFiles : row.keepFiles;
    const removeFiles = decisionAction === 'swapped' ? row.cleanupCandidateFiles : row.candidateFiles;

    item.append(
      head,
      quality,
      renderFileList(keepFiles, keepLabel),
      renderFileList(removeFiles, removeLabel),
      reason,
      controls
    );
    els.plexDupList.appendChild(item);
  }
}

function renderPlexCleanupPlan(plan) {
  els.plexCleanupPlan.replaceChildren();
  if (!plan?.planId) return;
  const progress = state.cleanupProgress?.planId === plan.planId ? state.cleanupProgress : null;

  const head = document.createElement('div');
  head.className = 'cleanup-head';
  const title = document.createElement('strong');
  title.textContent = `${plan.planId} - ${plan.status || 'planned'}`;
  const meta = document.createElement('span');
  meta.textContent = `${plan.moveCount || 0} files - ${formatTime(plan.createdAt)}`;
  head.append(title, meta);

  const stages = document.createElement('div');
  stages.className = 'cleanup-stages';
  for (const stage of toArray(plan.stages)) {
    const chip = document.createElement('span');
    chip.className = `cleanup-stage ${stage.status || 'pending'}`;
    chip.textContent = stage.label || stage.id || 'stage';
    stages.appendChild(chip);
  }

  const progressBlock = document.createElement('div');
  progressBlock.className = 'cleanup-progress';
  if (progress || plan.status === 'running') {
    const current = Number(progress?.current || 0);
    const total = Number(progress?.total || plan.moveCount || 0);
    const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
    const label = document.createElement('div');
    label.className = 'cleanup-progress-label';
    const message = progress?.message || 'Quarantine in progress.';
    label.textContent = total > 0
      ? `${message} ${current} of ${total} files (${percent}%).`
      : message;
    const bar = document.createElement('div');
    bar.className = 'cleanup-progress-track';
    const fill = document.createElement('div');
    fill.className = 'cleanup-progress-fill';
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    progressBlock.append(label, bar);
  }

  const verificationItems = toArray(plan.verificationItems);
  const verificationSummary = plan.verificationSummary || {};
  const verifiedCount = Number(verificationSummary.verified ?? verificationItems.filter((item) => item.verified).length);
  const issueCount = Number(verificationSummary.issues ?? verificationItems.filter((item) => item.status === 'issue').length);
  const restoredCount = Number(verificationSummary.restored ?? verificationItems.filter((item) => item.status === 'restored').length);
  const resolvedCount = Number(verificationSummary.resolved ?? (verifiedCount + restoredCount));
  const totalVerifyCount = Number(verificationSummary.total ?? verificationItems.length);
  const allItemsResolved = totalVerifyCount > 0 && resolvedCount === totalVerifyCount;
  const canVerifyItems = toArray(plan.stages).some((stage) => stage.id === 'verification' && stage.status === 'pending')
    && toArray(plan.stages).some((stage) => stage.id === 'quarantine' && stage.status === 'complete')
    && toArray(plan.stages).some((stage) => stage.id === 'plex_rescan' && stage.status === 'complete');

  const sourceFolders = toArray(plan.sourceFolders);
  const folderCleanup = plan.sourceFolderCleanup || {};
  const folderBlock = document.createElement('div');
  folderBlock.className = 'source-folder-list';
  if (sourceFolders.length || folderCleanup.removed?.length || folderCleanup.kept?.length) {
    const folderHead = document.createElement('div');
    folderHead.className = 'verification-head';
    const folderTitle = document.createElement('strong');
    folderTitle.textContent = 'Removed file source folders';
    const folderMeta = document.createElement('span');
    folderMeta.textContent = folderCleanup.removed?.length
      ? `${folderCleanup.removed.length} removed`
      : `${sourceFolders.length} listed`;
    folderHead.append(folderTitle, folderMeta);
    folderBlock.appendChild(folderHead);
    const cleanupFolderValues = [
      ...toArray(folderCleanup.removed).map((folder) => `REMOVED ${folder}`),
      ...toArray(folderCleanup.kept).map((folder) => `KEPT ${folder}`),
      ...toArray(folderCleanup.skipped).map((folder) => `SKIPPED ${folder}`),
      ...toArray(folderCleanup.alreadyMissing).map((folder) => `MISSING ${folder}`)
    ];
    const folderValues = cleanupFolderValues.length ? cleanupFolderValues : sourceFolders;
    for (const folder of folderValues) {
      const code = document.createElement('code');
      code.textContent = folder;
      folderBlock.appendChild(code);
    }
  }

  if (plan.status === 'deleted') {
    const complete = document.createElement('div');
    complete.className = 'cleanup-complete';
    const summary = plan.verificationSummary || {};
    const finalDelete = plan.finalDeleteSummary || {};
    complete.textContent = `Final delete completed. ${summary.resolved ?? summary.verified ?? 0} of ${summary.total ?? plan.moveCount ?? 0} cleanup items were resolved. ${finalDelete.deletedFileCount ?? 0} files and ${finalDelete.deletedFolderCount ?? 0} folders deleted.`;
    els.plexCleanupPlan.append(head, stages, complete);

    if (finalDelete.deletedFileCount || finalDelete.deletedFolderCount || finalDelete.keptFolderCount) {
      const reportActions = document.createElement('div');
      reportActions.className = 'duplicate-actions report-actions';
      const openReport = (type) => {
        const params = new URLSearchParams({
          type,
          planId: plan.planId
        });
        window.open(`/final-delete-report.html?${params.toString()}`, '_blank', 'noopener');
      };
      const filesButton = document.createElement('button');
      filesButton.type = 'button';
      filesButton.className = 'secondary';
      filesButton.textContent = `Deleted Files (${finalDelete.deletedFileCount || 0})`;
      filesButton.addEventListener('click', () => openReport('files'));
      const foldersButton = document.createElement('button');
      foldersButton.type = 'button';
      foldersButton.className = 'secondary';
      foldersButton.textContent = `Folder Results (${(finalDelete.deletedFolderCount || 0) + (finalDelete.keptFolderCount || 0)})`;
      foldersButton.addEventListener('click', () => openReport('folders'));
      reportActions.append(filesButton, foldersButton);
      els.plexCleanupPlan.appendChild(reportActions);
    }
    return;
  }

  const verifyList = document.createElement('div');
  verifyList.className = 'verification-list';
  const verifyHead = document.createElement('div');
  verifyHead.className = 'verification-head';
  const verifyTitle = document.createElement('strong');
  verifyTitle.textContent = 'Playback verification list';
  const verifyMeta = document.createElement('span');
  verifyMeta.textContent = `${resolvedCount} of ${totalVerifyCount} resolved${issueCount ? `, ${issueCount} issue${issueCount === 1 ? '' : 's'}` : ''}${restoredCount ? `, ${restoredCount} restored` : ''}`;
  verifyHead.append(verifyTitle, verifyMeta);
  verifyList.appendChild(verifyHead);
  for (const item of verificationItems) {
    const row = document.createElement('div');
    const itemStatus = item.status || (item.verified ? 'verified' : 'pending');
    row.className = `verification-item ${itemStatus}`;
    const top = document.createElement('label');
    top.className = 'verification-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = itemStatus === 'verified' || itemStatus === 'restored';
    check.disabled = state.busy || !canVerifyItems || itemStatus === 'restored';
    check.addEventListener('change', () => setPlexPlaybackVerificationItem(plan, item, check.checked));
    const name = document.createElement('span');
    name.textContent = item.title || 'Untitled';
    top.append(check, name);
    const status = document.createElement('span');
    status.className = `verification-status ${itemStatus}`;
    status.textContent = itemStatus.toUpperCase();
    const itemHead = document.createElement('div');
    itemHead.className = 'verification-item-head';
    itemHead.append(top, status);
    row.appendChild(itemHead);
    if (item.issueNote) {
      const issue = document.createElement('div');
      issue.className = 'verification-issue-note';
      issue.textContent = item.issueNote;
      row.appendChild(issue);
    }
    for (const file of toArray(item.keepFiles)) {
      const code = document.createElement('code');
      code.textContent = file;
      row.appendChild(code);
    }
    if (item.quarantinedFile) {
      const code = document.createElement('code');
      code.textContent = `QUARANTINED ${item.quarantinedFile}`;
      row.appendChild(code);
    }
    for (const file of toArray(item.failedKeepQuarantineFiles)) {
      const code = document.createElement('code');
      code.textContent = `FAILED FILE QUARANTINED ${file}`;
      row.appendChild(code);
    }
    const itemActions = document.createElement('div');
    itemActions.className = 'duplicate-actions verification-actions';
    const issueButton = document.createElement('button');
    issueButton.type = 'button';
    issueButton.className = 'secondary';
    issueButton.textContent = 'Issue';
    issueButton.disabled = state.busy || !canVerifyItems || itemStatus === 'restored';
    issueButton.addEventListener('click', () => markPlexPlaybackIssue(plan, item));
    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.className = 'danger';
    restoreButton.textContent = 'Restore Duplicate';
    restoreButton.disabled = state.busy || !canVerifyItems || itemStatus === 'restored';
    restoreButton.addEventListener('click', () => restorePlexPlaybackDuplicate(plan, item));
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'secondary';
    clearButton.textContent = 'Clear';
    clearButton.disabled = state.busy || !canVerifyItems || itemStatus === 'pending' || itemStatus === 'restored';
    clearButton.addEventListener('click', () => setPlexPlaybackVerificationItem(plan, item, false));
    itemActions.append(issueButton, restoreButton, clearButton);
    row.appendChild(itemActions);
    verifyList.appendChild(row);
  }

  const controls = document.createElement('div');
  controls.className = 'duplicate-actions';
  const canVerify = canVerifyItems && allItemsResolved;
  const verification = document.createElement('button');
  verification.type = 'button';
  verification.textContent = allItemsResolved ? 'Playback Resolved' : `Resolve All Movies (${resolvedCount}/${totalVerifyCount})`;
  verification.disabled = state.busy || !canVerify;
  verification.addEventListener('click', () => markPlaybackVerified(plan));
  const finalApproval = document.createElement('button');
  finalApproval.type = 'button';
  finalApproval.className = 'secondary';
  finalApproval.textContent = plan.finalDeleteApproval ? 'Delete Approved' : 'Final Delete Approval';
  const verificationComplete = toArray(plan.stages).some((stage) => stage.id === 'verification' && stage.status === 'complete');
  const priorComplete = toArray(plan.stages).some((stage) => stage.id === 'quarantine' && stage.status === 'complete')
    && toArray(plan.stages).some((stage) => stage.id === 'plex_rescan' && stage.status === 'complete')
    && verificationComplete;
  finalApproval.disabled = state.busy || Boolean(plan.finalDeleteApproval) || !priorComplete;
  finalApproval.addEventListener('click', () => recordFinalDeleteApproval(plan));
  controls.append(verification, finalApproval);

  els.plexCleanupPlan.append(head, stages);
  if (progressBlock.childElementCount) els.plexCleanupPlan.appendChild(progressBlock);
  if (folderBlock.childElementCount) els.plexCleanupPlan.appendChild(folderBlock);
  els.plexCleanupPlan.append(verifyList, controls);
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

function renderSystems(homeops) {
  const devices = toArray(homeops?.data?.devices);
  els.systemsList.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement('p');
    empty.className = 'subtle';
    empty.textContent = 'No systems loaded';
    els.systemsList.appendChild(empty);
    return;
  }

  for (const device of devices) {
    const row = els.systemRowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector('.system-name').textContent = device.name || 'device';
    row.querySelector('.system-host').textContent = `${device.host || '-'} - ${device.role || 'system'}`;

    const status = row.querySelector('.system-status');
    status.textContent = device.healthy ? 'Healthy' : 'Attention';
    status.className = `system-status ${statusClass(Boolean(device.healthy))}`;

    const ports = row.querySelector('.port-list');
    for (const tcp of toArray(device.tcp)) {
      const port = document.createElement('span');
      port.className = 'port';
      port.textContent = `${tcp.port} ${tcp.open ? 'open' : 'closed'}`;
      ports.appendChild(port);
    }
    els.systemsList.appendChild(row);
  }
}

function renderHomeAssistant(homeassistant) {
  const data = homeassistant?.data || {};
  els.haVersion.textContent = data.version || '-';
  els.haEntities.textContent = data.entityCount ?? '-';
  els.haUnavailable.textContent = data.unavailableOrUnknownCount ?? '-';
  els.haServices.textContent = data.serviceDomainCount ?? '-';

  const problemStates = toArray(data.unavailableOrUnknown).slice(0, 14);
  els.haFindings.replaceChildren();
  if (!problemStates.length) {
    els.haFindings.textContent = 'No unavailable or unknown entities in the latest report.';
    return;
  }
  for (const item of problemStates) {
    const line = document.createElement('div');
    const friendly = item.attributes?.friendly_name || item.entity_id;
    line.textContent = `${item.entity_id} - ${item.state} - ${friendly}`;
    els.haFindings.appendChild(line);
  }
}

function renderActivity(commands) {
  const rows = toArray(commands).reverse();
  els.activityCount.textContent = String(rows.length);
  els.activityList.replaceChildren();
  if (!rows.length) {
    const item = document.createElement('li');
    item.textContent = 'No command activity yet';
    els.activityList.appendChild(item);
    return;
  }

  for (const command of rows) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = `${command.action || 'message'} - ${command.status || 'unknown'}`;
    const meta = document.createElement('span');
    meta.textContent = `${formatTime(command.receivedAt)} from ${command.remoteAddress || '-'}`;
    const output = document.createElement('code');
    output.textContent = command.error || command.result?.output || command.text || '';
    item.append(title, meta, output);
    els.activityList.appendChild(item);
  }
}

function renderStatus(payload) {
  state.lastStatus = payload;
  const homeops = payload.homeops;
  const ha = payload.homeassistant;
  const plexDuplicates = payload.plexDuplicates;
  const homeopsData = homeops?.data || {};
  const haData = ha?.data || {};
  const server = payload.server || {};

  els.serverLine.textContent = `${server.computer || 'Control PC'} - ${server.homeOpsRoot || ''}`;
  els.networkState.textContent = homeopsData.healthy ? 'Healthy' : 'Attention';
  els.networkMeta.textContent = `${toArray(homeopsData.devices).length} systems - ${formatTime(homeops?.generatedAt)}`;
  els.haState.textContent = haData.apiMessage || 'Unknown';
  els.haMeta.textContent = `${haData.entityCount ?? '-'} entities - ${formatTime(ha?.generatedAt)}`;
  els.batteryState.textContent = haData.lowBatteryCount ?? '-';
  els.batteryMeta.textContent = `${haData.unavailableOrUnknownCount ?? '-'} unavailable or unknown`;
  els.lastHomeopsRun.textContent = formatTime(homeops?.generatedAt);
  els.lastHaRun.textContent = formatTime(ha?.generatedAt);

  renderActions(payload.actions);
  renderSystems(homeops);
  renderHomeAssistant(ha);
  renderPlexDuplicates(plexDuplicates);
}

function setBusy(isBusy, label = 'Working') {
  state.busy = isBusy;
  els.commandState.textContent = isBusy ? label : 'Idle';
  for (const button of document.querySelectorAll('button')) {
    button.disabled = isBusy;
  }
}

async function loadStatus() {
  if (!state.token) {
    setConnection('No Token', 'warn');
    els.commandState.textContent = 'Token required';
    return;
  }

  try {
    const payload = await loadStatusWithFallbacks();
    renderStatus(payload);
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
  } catch (error) {
    setConnection('Offline', 'bad');
    els.commandState.textContent = error.message;
  }
}

async function sendCommand(command) {
  if (state.busy) return;
  setBusy(true, 'Running');
  try {
    const payload = await apiFetch('/api/commands', {
      method: 'POST',
      body: JSON.stringify(command)
    });
    if (payload.status) {
      renderStatus(payload.status);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    els.commandText.value = '';
    setConnection('Online', 'good');
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
  }
}

async function setPlexDuplicateDecision(rowId, action, reason = '') {
  if (state.busy || !rowId) return;
  setBusy(true, action === 'ignored' ? 'Ignoring' : action === 'approved' ? 'Approving' : 'Clearing');
  try {
    const payload = await apiFetch('/api/plex/duplicates/decision', {
      method: 'POST',
      body: JSON.stringify({ rowId, action, reason })
    });
    state.plexCleanupPreview = null;
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
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
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    setConnection('Online', 'good');
    els.commandState.textContent = `Previewed ${payload.plan.moveCount || 0} quarantine move${payload.plan.moveCount === 1 ? '' : 's'}.`;
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
  }
}

async function finalizePlexCleanupPlan() {
  const report = state.lastStatus?.plexDuplicates;
  if (state.busy || !report?.path) return;
  const typed = window.prompt('Type QUARANTINE to move approved duplicate candidates to quarantine and rescan Plex.');
  if (typed !== 'QUARANTINE') return;
  setBusy(true, 'Quarantining');
  startCleanupProgressPolling();
  try {
    const payload = await apiFetch('/api/plex/duplicates/finalize-cleanup', {
      method: 'POST',
      body: JSON.stringify({ reportPath: report.path, confirm: 'QUARANTINE' })
    });
    state.plexCleanupPreview = null;
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    els.commandState.textContent = `Quarantined and rescanned: ${payload.plan.planId}`;
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    await refreshCleanupProgress();
    stopCleanupProgressPolling();
    setBusy(false);
  }
}

async function markPlaybackVerified(plan) {
  if (state.busy || !plan?.planId) return;
  setBusy(true, 'Verifying');
  try {
    const payload = await apiFetch('/api/plex/duplicates/verification-complete', {
      method: 'POST',
      body: JSON.stringify({ planId: plan.planId })
    });
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    els.commandState.textContent = 'Playback verification marked complete';
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
  }
}

async function setPlexPlaybackVerificationItem(plan, item, verified) {
  if (state.busy || !plan?.planId || !item?.key) return;
  setBusy(true, verified ? 'Marking Verified' : 'Clearing Verified');
  try {
    const payload = await apiFetch('/api/plex/duplicates/verification-item', {
      method: 'POST',
      body: JSON.stringify({
        planId: plan.planId,
        key: item.key,
        verified
      })
    });
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    const summary = payload.report?.cleanupPlan?.verificationSummary;
    els.commandState.textContent = summary
      ? `Playback checks: ${summary.resolved ?? summary.verified} of ${summary.total} resolved`
      : 'Playback check updated';
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
  }
}

async function markPlexPlaybackIssue(plan, item) {
  if (state.busy || !plan?.planId || !item?.key) return;
  const note = window.prompt('Describe the playback issue for this movie.');
  if (note === null) return;
  setBusy(true, 'Recording Issue');
  try {
    const payload = await apiFetch('/api/plex/duplicates/verification-issue', {
      method: 'POST',
      body: JSON.stringify({
        planId: plan.planId,
        key: item.key,
        issue: true,
        note: note.trim() || 'Playback issue'
      })
    });
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    const summary = payload.report?.cleanupPlan?.verificationSummary;
    els.commandState.textContent = summary
      ? `Playback issues: ${summary.issues || 0}; resolved ${summary.resolved || 0} of ${summary.total}`
      : 'Playback issue recorded';
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
  }
}

async function restorePlexPlaybackDuplicate(plan, item) {
  if (state.busy || !plan?.planId || !item?.key) return;
  const note = window.prompt('Describe the playback failure. The quarantined duplicate will be restored and the failed current file will be moved to quarantine.');
  if (note === null) return;
  const typed = window.prompt('Type RESTORE to restore the quarantined duplicate and quarantine the failed current file.');
  if (typed !== 'RESTORE') return;
  setBusy(true, 'Restoring Duplicate');
  try {
    const payload = await apiFetch('/api/plex/duplicates/restore-item', {
      method: 'POST',
      body: JSON.stringify({
        planId: plan.planId,
        key: item.key,
        confirm: 'RESTORE',
        note: note.trim() || 'Playback failed; restored duplicate'
      })
    });
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    const summary = payload.report?.cleanupPlan?.verificationSummary;
    els.commandState.textContent = summary
      ? `Duplicate restored. Resolved ${summary.resolved || 0} of ${summary.total}.`
      : 'Duplicate restored';
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
  }
}

async function recordFinalDeleteApproval(plan) {
  if (state.busy || !plan?.planId || plan.finalDeleteApproval) return;
  const typed = window.prompt("Type DELETE to permanently remove this plan's quarantined files after Plex verification is complete.");
  if (typed !== 'DELETE') return;
  setBusy(true, 'Approving Delete');
  try {
    const payload = await apiFetch('/api/plex/duplicates/final-delete-approval', {
      method: 'POST',
      body: JSON.stringify({
        planId: plan.planId,
        confirm: 'DELETE',
        verificationComplete: true
      })
    });
    if (state.lastStatus) {
      state.lastStatus.plexDuplicates = payload.report;
      renderStatus(state.lastStatus);
    }
    const history = await apiFetch('/api/commands');
    renderActivity(history.commands);
    setConnection('Online', 'good');
    els.commandState.textContent = 'Final delete completed';
  } catch (error) {
    setConnection('Error', 'bad');
    els.commandState.textContent = error.message;
  } finally {
    setBusy(false);
    if (state.lastStatus) renderStatus(state.lastStatus);
  }
}

function saveSettings() {
  state.apiUrl = normalizeUrl(els.apiUrl.value || window.location.origin);
  state.token = els.apiToken.value.trim();
  localStorage.setItem('homeops.apiUrl', state.apiUrl);
  localStorage.setItem('homeops.token', state.token);
  loadStatus();
}

els.apiUrl.value = state.apiUrl;
els.apiToken.value = state.token;
els.plexDupFilter.value = state.plexDuplicateFilter;
els.saveSettings.addEventListener('click', saveSettings);
els.refreshStatus.addEventListener('click', loadStatus);
els.scanPlexDuplicates.addEventListener('click', () => {
  state.plexCleanupPreview = null;
  sendCommand({ action: 'plex.duplicates.scan', text: 'Plex duplicate movie scan' });
});
els.previewPlexDuplicates.addEventListener('click', previewPlexCleanupPlan);
els.approvePlexDuplicates.addEventListener('click', finalizePlexCleanupPlan);
els.plexDupFilter.addEventListener('change', () => {
  state.plexDuplicateFilter = els.plexDupFilter.value || 'all';
  localStorage.setItem('homeops.plexDuplicateFilter', state.plexDuplicateFilter);
  if (state.lastStatus) renderStatus(state.lastStatus);
});
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

loadStatus();
