const params = new URLSearchParams(window.location.search);
const state = {
  apiUrl: localStorage.getItem('homeops.apiUrl') || window.location.origin,
  token: localStorage.getItem('homeops.token') || '',
  type: params.get('type') === 'folders' ? 'folders' : 'files',
  planId: params.get('planId') || '',
  plan: null,
  finalDelete: null
};

const els = {
  connectionPill: document.getElementById('connectionPill'),
  reportMeta: document.getElementById('reportMeta'),
  reportTitle: document.getElementById('reportTitle'),
  reportCount: document.getElementById('reportCount'),
  reportList: document.getElementById('reportList'),
  showFiles: document.getElementById('showFiles'),
  showFolders: document.getElementById('showFolders'),
  exportDoc: document.getElementById('exportDoc'),
  exportCsv: document.getElementById('exportCsv')
};

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function setConnection(text, tone = 'neutral') {
  els.connectionPill.textContent = text;
  els.connectionPill.className = `pill ${tone}`;
}

async function apiFetch(path) {
  if (!state.token) throw new Error('Missing HomeOps Remote token. Open the main app and save the token first.');
  const response = await fetch(`${state.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${state.token}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function rowsForCurrentType() {
  const summary = state.finalDelete || {};
  if (state.type === 'folders') {
    return [
      ...toArray(summary.deletedFolders).map((folder) => ({ status: 'Deleted', folder })),
      ...toArray(summary.keptFolders).map((folder) => ({ status: 'Kept', folder })),
      ...toArray(summary.alreadyMissingFolders).map((folder) => ({ status: 'Already missing', folder }))
    ];
  }
  return toArray(summary.deletedFiles).map((entry) => ({
    title: entry.title || '',
    file: entry.file || '',
    folder: entry.folder || ''
  }));
}

function render() {
  const rows = rowsForCurrentType();
  const summary = state.finalDelete || {};
  const planId = state.plan?.planId || state.planId || 'cleanup plan';
  els.reportMeta.textContent = `${planId} - ${state.plan?.status || 'unknown'}`;
  els.reportTitle.textContent = state.type === 'folders' ? 'Folder Results' : 'Deleted Files';
  els.reportCount.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
  els.showFiles.classList.toggle('selected', state.type === 'files');
  els.showFolders.classList.toggle('selected', state.type === 'folders');

  els.reportList.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'subtle';
    empty.textContent = state.type === 'folders' ? 'No folder results were recorded.' : 'No deleted files were recorded.';
    els.reportList.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'report-table';
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  const headers = state.type === 'folders' ? ['Status', 'Folder'] : ['Title', 'Deleted File', 'Folder'];
  for (const label of headers) {
    const th = document.createElement('th');
    th.textContent = label;
    header.appendChild(th);
  }
  thead.appendChild(header);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    const values = state.type === 'folders'
      ? [row.status, row.folder]
      : [row.title || '-', row.file, row.folder];
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.reportList.appendChild(table);

  const counts = document.createElement('p');
  counts.className = 'subtle';
  counts.textContent = `Deleted files: ${summary.deletedFileCount || 0}. Deleted folders: ${summary.deletedFolderCount || 0}. Folders left in place: ${summary.keptFolderCount || 0}.`;
  els.reportList.prepend(counts);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(filename, type, body) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const rows = rowsForCurrentType();
  const headers = state.type === 'folders' ? ['Status', 'Folder'] : ['Title', 'Deleted File', 'Folder'];
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    const values = state.type === 'folders'
      ? [row.status, row.folder]
      : [row.title || '-', row.file, row.folder];
    lines.push(values.map(csvEscape).join(','));
  }
  downloadBlob(`${state.plan?.planId || 'plex-cleanup'}-${state.type}.csv`, 'text/csv;charset=utf-8', lines.join('\r\n'));
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function exportDoc() {
  const rows = rowsForCurrentType();
  const headers = state.type === 'folders' ? ['Status', 'Folder'] : ['Title', 'Deleted File', 'Folder'];
  const bodyRows = rows.map((row) => {
    const values = state.type === 'folders'
      ? [row.status, row.folder]
      : [row.title || '-', row.file, row.folder];
    return `<tr>${values.map((value) => `<td>${htmlEscape(value)}</td>`).join('')}</tr>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Final Delete Verification</title></head><body><h1>${htmlEscape(els.reportTitle.textContent)}</h1><p>${htmlEscape(els.reportMeta.textContent)}</p><table border="1" cellspacing="0" cellpadding="4"><thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join('')}</tr></thead><tbody>${bodyRows}</tbody></table></body></html>`;
  downloadBlob(`${state.plan?.planId || 'plex-cleanup'}-${state.type}.doc`, 'application/msword;charset=utf-8', html);
}

async function load() {
  try {
    const payload = await apiFetch('/api/plex/duplicates');
    state.plan = payload.report?.cleanupPlan || null;
    if (state.planId && state.plan?.planId !== state.planId) {
      throw new Error('Requested cleanup plan is not the latest cleanup plan.');
    }
    state.finalDelete = state.plan?.finalDeleteSummary || null;
    if (!state.finalDelete) throw new Error('No final delete summary is available.');
    setConnection('Online', 'good');
    render();
  } catch (error) {
    setConnection('Error', 'bad');
    els.reportMeta.textContent = error.message;
    els.reportList.textContent = '';
  }
}

els.showFiles.addEventListener('click', () => {
  state.type = 'files';
  render();
});
els.showFolders.addEventListener('click', () => {
  state.type = 'folders';
  render();
});
els.exportDoc.addEventListener('click', exportDoc);
els.exportCsv.addEventListener('click', exportCsv);

load();
