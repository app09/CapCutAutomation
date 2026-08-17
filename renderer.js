const elements = {
  refreshProjectsBtn: document.getElementById('refreshProjectsBtn'),
  extractCaptionsBtn: document.getElementById('extractCaptionsBtn'),
  applyChangesBtn: document.getElementById('applyChangesBtn'),
  backupProjectBtn: document.getElementById('backupProjectBtn'),
  restoreBackupBtn: document.getElementById('restoreBackupBtn'),
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  killCapCutBtn: document.getElementById('killCapCutBtn'),
  downloadTxtBtn: document.getElementById('downloadTxtBtn'),
  uploadTxtInput: document.getElementById('uploadTxtInput'),
  uploadTxtLabel: document.getElementById('uploadTxtLabel'),
  animationPreset: document.getElementById('animationPreset'),
  applyAnimationBtn: document.getElementById('applyAnimationBtn'),
  randomTransitionsBtn: document.getElementById('randomTransitionsBtn'),
  exportSrtBtn: document.getElementById('exportSrtBtn'),
  syncEditor: document.getElementById('syncEditor'),
  syncUploadInput: document.getElementById('syncUploadInput'),
  syncUploadLabel: document.getElementById('syncUploadLabel'),
  applyImageSyncBtn: document.getElementById('applyImageSyncBtn'),
  applyAudioSyncBtn: document.getElementById('applyAudioSyncBtn'),
  projectList: document.getElementById('projectList'),
  projectCount: document.getElementById('projectCount'),
  scanInfo: document.getElementById('scanInfo'),
  selectedProjectName: document.getElementById('selectedProjectName'),
  selectedProjectPath: document.getElementById('selectedProjectPath'),
  captionEditor: document.getElementById('captionEditor'),
  captionCount: document.getElementById('captionCount'),
  backupStatus: document.getElementById('backupStatus'),
  statusBar: document.getElementById('statusBar'),
  selectedProjectStats: document.getElementById('selectedProjectStats'),
  statClips: document.getElementById('statClips'),
  statImages: document.getElementById('statImages'),
  statVideos: document.getElementById('statVideos'),
  statAudio: document.getElementById('statAudio'),
  statDuration: document.getElementById('statDuration'),
  logPanel: document.getElementById('logPanel'),
  clearLogBtn: document.getElementById('clearLogBtn')
};

const state = {
  projects: [],
  selectedProject: null,
  extractedCaptionCount: 0,
  hasLoadedCaptions: false
};

const MAX_LOG_ENTRIES = 500;

// Append a color-coded, timestamped entry to the Log Panel.
function appendLog(level, message, at = Date.now()) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(at).toLocaleTimeString();

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = message;

  entry.appendChild(time);
  entry.appendChild(msg);

  // Auto-scroll only when the user is already at (or near) the bottom.
  const nearBottom =
    elements.logPanel.scrollTop + elements.logPanel.clientHeight >= elements.logPanel.scrollHeight - 24;

  elements.logPanel.appendChild(entry);

  while (elements.logPanel.childElementCount > MAX_LOG_ENTRIES) {
    elements.logPanel.removeChild(elements.logPanel.firstElementChild);
  }

  if (nearBottom) {
    elements.logPanel.scrollTop = elements.logPanel.scrollHeight;
  }
}

function setStatus(message, type = 'info') {
  // Mirror every status change to the DevTools console (open with Ctrl+Shift+I).
  const sink = type === 'error' ? console.error : type === 'warning' ? console.warn : console.log;
  sink(`[ui:${type}] ${message}`);
  elements.statusBar.textContent = message;
  elements.statusBar.className = `status-bar ${type}`;
  appendLog(type, message);
}

function setFileButtonsEnabled(isEnabled) {
  elements.downloadTxtBtn.disabled = !isEnabled;
  if (isEnabled) {
    elements.uploadTxtInput.disabled = false;
    elements.uploadTxtLabel.classList.remove('disabled-label');
  } else {
    elements.uploadTxtInput.disabled = true;
    elements.uploadTxtLabel.classList.add('disabled-label');
  }
}

function setButtonsDisabled(isDisabled) {
  elements.extractCaptionsBtn.disabled = isDisabled;
  elements.backupProjectBtn.disabled = isDisabled;
  elements.restoreBackupBtn.disabled = isDisabled;
  elements.clearCacheBtn.disabled = isDisabled;
  elements.applyChangesBtn.disabled = isDisabled || !state.hasLoadedCaptions;

  // Motion / SRT / Image Sync only require a selected project.
  elements.animationPreset.disabled = isDisabled;
  elements.applyAnimationBtn.disabled = isDisabled;
  elements.randomTransitionsBtn.disabled = isDisabled;
  elements.exportSrtBtn.disabled = isDisabled;
  updateSyncControls(isDisabled);
}

function updateSyncControls(isDisabled) {
  const projectDisabled = isDisabled || !state.selectedProject;

  if (projectDisabled) {
    elements.syncUploadInput.disabled = true;
    elements.syncUploadLabel.classList.add('disabled-label');
  } else {
    elements.syncUploadInput.disabled = false;
    elements.syncUploadLabel.classList.remove('disabled-label');
  }

  elements.applyImageSyncBtn.disabled = projectDisabled || !elements.syncEditor.value.trim();
  // Audio-Cut Sync only needs a selected project — it reads timing from the
  // project's own audio track, so no SRT text is required.
  elements.applyAudioSyncBtn.disabled = projectDisabled;
}

async function populatePresets() {
  try {
    const presets = await window.capcutApi.listAnimationPresets();
    console.log(`[ui] loaded ${presets.length} animation presets:`, presets.map((p) => p.id).join(', '));
    elements.animationPreset.innerHTML = '';
    presets.forEach((preset) => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      elements.animationPreset.appendChild(option);
    });
  } catch (_error) {
    // Leave the dropdown empty; applying will surface a clear error if used.
  }
}

function resetEditor() {
  elements.captionEditor.value = '';
  elements.captionCount.textContent = '0 captions';
  state.extractedCaptionCount = 0;
  state.hasLoadedCaptions = false;
  elements.applyChangesBtn.disabled = true;
  setFileButtonsEnabled(false);
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch (_error) {
    return 'Unknown';
  }
}

// CapCut draft durations are in microseconds.
function formatDuration(durationUs) {
  if (!(durationUs > 0)) {
    return '0:00';
  }
  const totalSeconds = Math.round(durationUs / 1000000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function renderSelectedStats(stats) {
  if (!stats) {
    elements.selectedProjectStats.hidden = true;
    return;
  }

  elements.statClips.textContent = `${stats.clipCount} clip${stats.clipCount === 1 ? '' : 's'}`;
  elements.statImages.textContent = `${stats.imageCount} image${stats.imageCount === 1 ? '' : 's'}`;
  elements.statVideos.textContent = `${stats.videoCount} video${stats.videoCount === 1 ? '' : 's'}`;
  elements.statAudio.textContent = `${stats.audioTrackCount} audio track${stats.audioTrackCount === 1 ? '' : 's'}`;
  elements.statDuration.textContent = `⏱ ${formatDuration(stats.durationUs)}`;
  elements.selectedProjectStats.hidden = false;
}

function updateSelection(project) {
  state.selectedProject = project;

  if (!project) {
    elements.selectedProjectName.textContent = 'None selected';
    elements.selectedProjectPath.textContent = 'Choose a project from the left panel.';
    renderSelectedStats(null);
    setButtonsDisabled(true);
    resetEditor();
    renderProjects();
    return;
  }

  elements.selectedProjectName.textContent = project.name;
  elements.selectedProjectPath.textContent = `${project.path} • ${project.draftFileName}`;
  renderSelectedStats(project.stats);
  setButtonsDisabled(false);
  resetEditor();
  renderProjects();
}

function renderProjects() {
  elements.projectCount.textContent = `${state.projects.length} project${state.projects.length === 1 ? '' : 's'}`;
  elements.projectList.innerHTML = '';

  if (!state.projects.length) {
    elements.projectList.innerHTML = '<div class="empty-state">No CapCut projects were found in the default scan locations.</div>';
    return;
  }

  state.projects.forEach((project) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-card ${state.selectedProject?.path === project.path ? 'selected' : ''}`;

    const s = project.stats;
    const statsLine = s
      ? `<div class="project-stats-line">${s.clipCount} clips (${s.imageCount} img / ${s.videoCount} vid) • ${s.audioTrackCount} audio • ${escapeHtml(formatDuration(s.durationUs))}</div>`
      : '';

    button.innerHTML = `
      <span class="project-name">${escapeHtml(project.name)}</span>
      <div class="project-path">${escapeHtml(project.path)}</div>
      <div class="project-meta-line">${project.draftFileName} • Updated ${escapeHtml(formatDate(project.lastModified))}</div>
      ${statsLine}
      <div class="project-meta-line">${project.backupCount} backup${project.backupCount === 1 ? '' : 's'}</div>
    `;

    button.addEventListener('click', () => updateSelection(project));
    elements.projectList.appendChild(button);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function refreshProjects() {
  setStatus('Scanning CapCut project folders...', 'info');
  elements.scanInfo.textContent = 'Scanning default CapCut locations';

  try {
    const projects = await window.capcutApi.scanProjects();
    state.projects = projects;
    renderProjects();

    if (state.selectedProject) {
      const refreshedSelection = projects.find((project) => project.path === state.selectedProject.path);
      updateSelection(refreshedSelection || null);
    }

    if (!projects.length) {
      setStatus('No CapCut projects found. Make sure CapCut has local desktop projects in the default folders.', 'warning');
      return;
    }

    setStatus(`Found ${projects.length} CapCut project${projects.length === 1 ? '' : 's'}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Failed to scan CapCut projects.', 'error');
  }
}

async function extractCaptions() {
  if (!state.selectedProject) {
    return;
  }

  setStatus('Reading caption text from the selected project...', 'info');

  try {
    const result = await window.capcutApi.extractCaptions(
      state.selectedProject.path,
      state.selectedProject.draftFileName
    );

    elements.captionEditor.value = result.editorText;
    elements.captionCount.textContent = `${result.captionCount} caption${result.captionCount === 1 ? '' : 's'}`;
    state.extractedCaptionCount = result.captionCount;
    state.hasLoadedCaptions = true;
    elements.applyChangesBtn.disabled = false;
    setFileButtonsEnabled(true);

    if (result.hadEmbeddedNewlines) {
      setStatus('Captions extracted. Some embedded line breaks were flattened to spaces for line-by-line editing.', 'warning');
    } else {
      setStatus(`Extracted ${result.captionCount} caption${result.captionCount === 1 ? '' : 's'}.`, 'success');
    }
  } catch (error) {
    state.hasLoadedCaptions = false;
    elements.applyChangesBtn.disabled = true;
    setStatus(error.message || 'Failed to extract captions.', 'error');
  }
}

async function applyChanges() {
  if (!state.selectedProject || !state.hasLoadedCaptions) {
    return;
  }

  setStatus('Creating backup and writing edited captions back to the project...', 'info');

  try {
    const result = await window.capcutApi.applyChanges(
      state.selectedProject.path,
      state.selectedProject.draftFileName,
      elements.captionEditor.value
    );

    elements.backupStatus.textContent = `Latest backup: ${result.backupId}`;
    setStatus(`Saved ${result.updatedCaptionCount} caption${result.updatedCaptionCount === 1 ? '' : 's'} to ${result.draftFileName}.`, 'success');
    await refreshProjects();
  } catch (error) {
    setStatus(error.message || 'Failed to apply caption changes.', 'error');
  }
}

async function backupProject() {
  if (!state.selectedProject) {
    return;
  }

  setStatus('Creating full project backup...', 'info');

  try {
    const result = await window.capcutApi.backupProject(state.selectedProject.path);
    elements.backupStatus.textContent = `Latest backup: ${result.backupId}`;
    setStatus(`Backup created: ${result.backupId}`, 'success');
    await refreshProjects();
  } catch (error) {
    setStatus(error.message || 'Failed to create backup.', 'error');
  }
}

async function restoreBackup() {
  if (!state.selectedProject) {
    return;
  }

  setStatus('Restoring latest backup...', 'info');

  try {
    const result = await window.capcutApi.restoreBackup(state.selectedProject.path);

    if (result?.cancelled) {
      setStatus('Restore cancelled.', 'info');
      return;
    }

    elements.backupStatus.textContent = `Restored backup: ${result.restoredBackupId}`;
    setStatus(`Project restored from backup ${result.restoredBackupId}.`, 'success');
    await refreshProjects();
    await extractCaptions();
  } catch (error) {
    setStatus(error.message || 'Failed to restore backup.', 'error');
  }
}

function downloadCaptions() {
  const text = elements.captionEditor.value;
  if (!text.trim()) {
    setStatus('Nothing to download — extract captions first.', 'warning');
    return;
  }

  const projectName = state.selectedProject?.name || 'captions';
  const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${safeName}_captions.txt`;

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);

  setStatus(`Downloaded ${filename}.`, 'success');
}

function uploadCaptions(event) {
  const file = event.target.files?.[0];
  // Reset input so the same file can be re-selected if needed
  event.target.value = '';

  if (!file) return;

  if (!file.name.endsWith('.txt') && file.type !== 'text/plain') {
    setStatus('Please upload a plain .txt file.', 'error');
    return;
  }

  const reader = new FileReader();

  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // Strip a trailing blank line that many editors append
    const trimmedLines = lines[lines.length - 1].trim() === '' ? lines.slice(0, -1) : lines;

    if (state.hasLoadedCaptions && trimmedLines.length !== state.extractedCaptionCount) {
      setStatus(
        `Line count mismatch: file has ${trimmedLines.length} line${trimmedLines.length === 1 ? '' : 's'} but project has ${state.extractedCaptionCount} caption${state.extractedCaptionCount === 1 ? '' : 's'}. Edit was not applied.`,
        'error'
      );
      return;
    }

    elements.captionEditor.value = trimmedLines.join('\n');
    elements.captionCount.textContent = `${trimmedLines.length} caption${trimmedLines.length === 1 ? '' : 's'}`;
    state.extractedCaptionCount = trimmedLines.length;
    state.hasLoadedCaptions = true;
    elements.applyChangesBtn.disabled = false;
    setStatus(`Loaded ${trimmedLines.length} caption${trimmedLines.length === 1 ? '' : 's'} from ${file.name}. Review and click Apply Changes.`, 'success');
  };

  reader.onerror = () => {
    setStatus('Failed to read the uploaded file.', 'error');
  };

  reader.readAsText(file, 'utf-8');
}

async function applyAnimation() {
  if (!state.selectedProject) {
    return;
  }

  const presetId = elements.animationPreset.value;
  if (!presetId) {
    setStatus('Select an animation preset first.', 'warning');
    return;
  }

  console.log(`[ui] applyAnimation → preset="${presetId}" project="${state.selectedProject.path}"`);
  setStatus('Creating backup and applying animation to all clips...', 'info');

  try {
    const result = await window.capcutApi.applyAnimation(
      state.selectedProject.path,
      state.selectedProject.draftFileName,
      presetId
    );

    console.log('[ui] applyAnimation result:', result);
    elements.backupStatus.textContent = `Latest backup: ${result.backupId}`;
    setStatus(`Animated ${result.animatedCount} clip${result.animatedCount === 1 ? '' : 's'}. Reopen the project in CapCut to see the motion.`, 'success');
    await refreshProjects();
  } catch (error) {
    setStatus(error.message || 'Failed to apply animation.', 'error');
  }
}

async function applyRandomTransitions() {
  if (!state.selectedProject) {
    return;
  }

  console.log(`[ui] applyRandomTransitions → project="${state.selectedProject.path}"`);
  setStatus('Detecting leading transitions and applying them randomly to all clips...', 'info');

  try {
    const result = await window.capcutApi.applyRandomTransitions(
      state.selectedProject.path,
      state.selectedProject.draftFileName
    );

    console.log('[ui] applyRandomTransitions result:', result);
    elements.backupStatus.textContent = `Latest backup: ${result.backupId}`;
    setStatus(
      `Applied ${result.appliedCount} transition${result.appliedCount === 1 ? '' : 's'} randomly ` +
        `from ${result.detectedCount} detected (${result.detectedNames.join(', ')}). ` +
        'Reopen the project in CapCut to see them.',
      'success'
    );
    await refreshProjects();
  } catch (error) {
    setStatus(error.message || 'Failed to apply random transitions.', 'error');
  }
}

async function exportSrt() {
  if (!state.selectedProject) {
    return;
  }

  setStatus('Reading subtitle timings and building .srt...', 'info');

  try {
    const result = await window.capcutApi.exportSrt(
      state.selectedProject.path,
      state.selectedProject.draftFileName
    );

    console.log(`[ui] exportSrt → ${result.cueCount} cues`);
    const safeName = (state.selectedProject.name || 'subtitles').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${safeName}.srt`;

    const blob = new Blob([result.srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);

    setStatus(`Exported ${result.cueCount} subtitle${result.cueCount === 1 ? '' : 's'} to ${filename}.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Failed to export subtitles.', 'error');
  }
}

async function applyImageSync() {
  if (!state.selectedProject) {
    return;
  }

  const srtText = elements.syncEditor.value;
  if (!srtText.trim()) {
    setStatus('Paste SRT text or upload a .srt file first.', 'warning');
    return;
  }

  console.log(`[ui] applyImageSync → ${srtText.length} chars of SRT for "${state.selectedProject.path}"`);
  setStatus('Creating backup and syncing clip durations to subtitle blocks...', 'info');

  try {
    const result = await window.capcutApi.imageSync(
      state.selectedProject.path,
      state.selectedProject.draftFileName,
      srtText
    );

    console.log('[ui] applyImageSync result:', result);
    elements.backupStatus.textContent = `Latest backup: ${result.backupId}`;

    if (result.cueCount !== result.clipCount) {
      setStatus(
        `Synced ${result.syncedCount} clip${result.syncedCount === 1 ? '' : 's'}. Note: ${result.cueCount} subtitle block${result.cueCount === 1 ? '' : 's'} vs ${result.clipCount} clip${result.clipCount === 1 ? '' : 's'} — extras were left in sequence.`,
        'warning'
      );
    } else {
      setStatus(`Synced ${result.syncedCount} clip${result.syncedCount === 1 ? '' : 's'} to the subtitle timing.`, 'success');
    }

    await refreshProjects();
  } catch (error) {
    setStatus(error.message || 'Failed to sync images with subtitles.', 'error');
  }
}

async function killCapCut() {
  const confirmed = window.confirm(
    'Force-close CapCut now?\n\nAny unsaved work open in CapCut will be lost. ' +
      'This releases the project from memory so external edits show up on the next open.'
  );
  if (!confirmed) {
    setStatus('Kill CapCut cancelled.', 'info');
    return;
  }

  setStatus('Force-closing CapCut...', 'info');

  try {
    const result = await window.capcutApi.killCapCut();

    if (!result.wasRunning) {
      setStatus('CapCut was not running.', 'info');
    } else if (result.killed) {
      setStatus('CapCut closed. You can now apply changes and reopen the project fresh.', 'success');
    } else {
      setStatus('Could not fully close CapCut — try closing it manually.', 'warning');
    }
  } catch (error) {
    setStatus(error.message || 'Failed to close CapCut.', 'error');
  }
}

async function clearCache() {
  if (!state.selectedProject) {
    return;
  }

  setStatus('Clearing stale cache files for the selected project...', 'info');

  try {
    const result = await window.capcutApi.clearProjectCache(state.selectedProject.path);
    setStatus(
      `Cleared ${result.removed} cache file${result.removed === 1 ? '' : 's'} (.tmp/.bak). ` +
        'Reopen the project in CapCut to load the latest saved timeline.',
      'success'
    );
  } catch (error) {
    setStatus(error.message || 'Failed to clear cache.', 'error');
  }
}

async function applyAudioSync() {
  if (!state.selectedProject) {
    return;
  }

  console.log(`[ui] applyAudioSync → project="${state.selectedProject.path}"`);
  setStatus('Creating backup and syncing clip durations to the audio cuts...', 'info');

  try {
    const result = await window.capcutApi.audioSync(
      state.selectedProject.path,
      state.selectedProject.draftFileName
    );

    console.log('[ui] applyAudioSync result:', result);
    elements.backupStatus.textContent = `Latest backup: ${result.backupId}`;

    if (result.cueCount !== result.clipCount) {
      setStatus(
        `Synced ${result.syncedCount} clip${result.syncedCount === 1 ? '' : 's'} to the audio cuts. ` +
          `Note: ${result.cueCount} audio cut${result.cueCount === 1 ? '' : 's'} vs ${result.clipCount} clip${result.clipCount === 1 ? '' : 's'} — extras were left in sequence. ` +
          'Reopen the project in CapCut to see it.',
        'warning'
      );
    } else {
      setStatus(
        `Synced ${result.syncedCount} clip${result.syncedCount === 1 ? '' : 's'} to the audio cuts. Reopen the project in CapCut to see it.`,
        'success'
      );
    }

    await refreshProjects();
  } catch (error) {
    setStatus(error.message || 'Failed to sync clips to audio cuts.', 'error');
  }
}

function uploadSrtFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';

  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.srt') && file.type !== 'text/plain') {
    setStatus('Please upload a .srt file.', 'error');
    return;
  }

  const reader = new FileReader();

  reader.onload = (e) => {
    elements.syncEditor.value = e.target.result;
    updateSyncControls(false);
    setStatus(`Loaded ${file.name}. Review the timing, then click Apply Image Sync.`, 'success');
  };

  reader.onerror = () => {
    setStatus('Failed to read the .srt file.', 'error');
  };

  reader.readAsText(file, 'utf-8');
}

elements.refreshProjectsBtn.addEventListener('click', refreshProjects);
elements.extractCaptionsBtn.addEventListener('click', extractCaptions);
elements.applyChangesBtn.addEventListener('click', applyChanges);
elements.backupProjectBtn.addEventListener('click', backupProject);
elements.restoreBackupBtn.addEventListener('click', restoreBackup);
elements.clearCacheBtn.addEventListener('click', clearCache);
elements.killCapCutBtn.addEventListener('click', killCapCut);
elements.downloadTxtBtn.addEventListener('click', downloadCaptions);
elements.uploadTxtInput.addEventListener('change', uploadCaptions);
elements.applyAnimationBtn.addEventListener('click', applyAnimation);
elements.randomTransitionsBtn.addEventListener('click', applyRandomTransitions);
elements.exportSrtBtn.addEventListener('click', exportSrt);
elements.applyImageSyncBtn.addEventListener('click', applyImageSync);
elements.applyAudioSyncBtn.addEventListener('click', applyAudioSync);
elements.syncUploadInput.addEventListener('change', uploadSrtFile);
elements.syncEditor.addEventListener('input', () => updateSyncControls(false));
elements.clearLogBtn.addEventListener('click', () => {
  elements.logPanel.innerHTML = '';
  appendLog('info', 'Log cleared.');
});

// ── Page navigation ─────────────────────────────────────────
// Each function lives on its own page; the tab bar toggles which is visible.
const navTabs = Array.from(document.querySelectorAll('.nav-tab'));
const pages = Array.from(document.querySelectorAll('.page'));

function switchPage(pageId) {
  navTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.page === pageId));
  pages.forEach((page) => page.classList.toggle('active', page.dataset.page === pageId));
}

navTabs.forEach((tab) => {
  tab.addEventListener('click', () => switchPage(tab.dataset.page));
});

// Stream main-process activity ([ipc]/[service] lines) into the Log Panel.
window.capcutApi.onLog((entry) => {
  appendLog(entry.level, entry.message, entry.at);
});

appendLog('info', 'App started. Ready.');
populatePresets();
refreshProjects();
