const fs = require('fs/promises');
const { existsSync } = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const animationPresets = require('./animation-presets');
const { parseSrt, formatSrt } = require('./srt');

const DRAFT_FILE_CANDIDATES = ['draft_content.json', 'draft_info.json'];
const META_FILE_CANDIDATES = ['draft_meta_info.json', 'draft_meta_info.json'];

function getDefaultProjectRoots() {
  const roots = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    roots.push(path.join(localAppData, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
  }

  if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
  }

  return roots;
}

async function safeReadDir(targetPath) {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function createBackupId() {
  return new Date().toISOString().replace(/[.:]/g, '-');
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function readJson(targetPath) {
  const raw = await fs.readFile(targetPath, 'utf8');

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.basename(targetPath)}: ${error.message}`);
  }
}

const execFileAsync = promisify(execFile);

// CapCut keeps the whole draft in memory and rewrites draft_content.json on
// autosave, silently clobbering anything written from outside. Every mutating
// operation must refuse to run while CapCut is open.
async function isCapCutRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq CapCut.exe', '/NH']);
      return /CapCut\.exe/i.test(stdout);
    }

    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('pgrep', ['-x', 'CapCut']).catch(() => ({ stdout: '' }));
      return stdout.trim().length > 0;
    }
  } catch (_error) {
    // If detection fails, allow the write rather than blocking the app.
  }

  return false;
}

async function assertCapCutClosed() {
  if (await isCapCutRunning()) {
    throw new Error(
      'CapCut is currently running. Close CapCut first — otherwise it will overwrite these changes ' +
        'with its own autosave. Then apply again and reopen the project.'
    );
  }
}

// Force-quit CapCut so it releases the project from memory (its in-memory copy
// is what overwrites external edits and hides them until a fresh reopen).
async function killCapCut() {
  if (!(await isCapCutRunning())) {
    return { wasRunning: false, killed: false };
  }

  try {
    if (process.platform === 'win32') {
      // /T also terminates child processes; /F forces it.
      await execFileAsync('taskkill', ['/IM', 'CapCut.exe', '/F', '/T']);
    } else if (process.platform === 'darwin') {
      await execFileAsync('pkill', ['-x', 'CapCut']).catch(() => execFileAsync('killall', ['CapCut']));
    }
  } catch (_error) {
    // taskkill/pkill exit non-zero when nothing matched — re-check below.
  }

  // Give the OS a moment to reap the process, then confirm.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stillRunning = await isCapCutRunning();

  console.log(`[service] killCapCut — ${stillRunning ? 'CapCut is still running' : 'CapCut terminated'}`);
  return { wasRunning: true, killed: !stillRunning };
}

// CapCut scratch/backup sidecars that can linger with stale data. Removing them
// forces CapCut to rebuild from the live draft_content.json on next open.
const CACHE_FILE_PATTERN = /\.(tmp|bak)$/i;

async function collectCacheFiles(dir, out) {
  for (const entry of await safeReadDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectCacheFiles(full, out);
    } else if (CACHE_FILE_PATTERN.test(entry.name)) {
      out.push(full);
    }
  }
}

// Delete the .tmp/.bak sidecar files inside a project (root + Timelines/*).
// The real draft_content.json / project.json files are never touched.
async function clearProjectCache({ projectPath }) {
  await assertCapCutClosed();

  if (!existsSync(projectPath)) {
    throw new Error('Selected project folder was not found.');
  }

  const files = [];
  await collectCacheFiles(projectPath, files);

  let removed = 0;
  for (const file of files) {
    try {
      await fs.rm(file, { force: true });
      removed += 1;
    } catch (_error) {
      // Skip anything still locked; report the rest.
    }
  }

  console.log(
    `[service] clearProjectCache — removed ${removed}/${files.length} cache file(s) (.tmp/.bak) ` +
      `from "${path.basename(projectPath)}"`
  );

  return { removed, scanned: files.length };
}

// Newer CapCut desktop (8.x+, draft new_version 150+) moved the live timeline
// out of the project-root draft_content.json into
//   Timelines/<main_timeline_id>/draft_content.json
// The root file is now just a legacy mirror the app ignores, so edits written
// there have no visible effect. Timelines/project.json points at the main
// timeline id. Returns the resolved inner draft, or null for the old format.
async function resolveTimelineDraftFile(projectPath) {
  const timelineIndexPath = path.join(projectPath, 'Timelines', 'project.json');

  if (!(await fileExists(timelineIndexPath))) {
    return null;
  }

  let mainTimelineId;
  try {
    const index = await readJson(timelineIndexPath);
    const activeTimeline = Array.isArray(index?.timelines)
      ? index.timelines.find((t) => t && !t.is_marked_delete)
      : null;
    mainTimelineId = index?.main_timeline_id || activeTimeline?.id;
  } catch (_error) {
    // Unreadable index → fall back to the legacy root draft.
    return null;
  }

  if (typeof mainTimelineId !== 'string' || !mainTimelineId.trim()) {
    return null;
  }

  const draftFileName = path.join('Timelines', mainTimelineId, 'draft_content.json');
  const draftFilePath = path.join(projectPath, draftFileName);

  if (!(await fileExists(draftFilePath))) {
    return null;
  }

  return { draftFileName, draftFilePath, format: 'timelines' };
}

async function resolveDraftFile(projectPath, preferredDraftFileName) {
  // Auto-detect the CapCut format. New format (Timelines/…) always wins because
  // its inner draft is the one CapCut actually reads and renders.
  const timelineDraft = await resolveTimelineDraftFile(projectPath);
  if (timelineDraft) {
    return timelineDraft;
  }

  // Legacy format: draft JSON lives directly in the project root.
  if (preferredDraftFileName) {
    const candidate = path.join(projectPath, preferredDraftFileName);

    if (await fileExists(candidate)) {
      return {
        draftFileName: preferredDraftFileName,
        draftFilePath: candidate,
        format: 'legacy'
      };
    }
  }

  for (const draftFileName of DRAFT_FILE_CANDIDATES) {
    const candidate = path.join(projectPath, draftFileName);

    if (await fileExists(candidate)) {
      return {
        draftFileName,
        draftFilePath: candidate,
        format: 'legacy'
      };
    }
  }

  throw new Error('No CapCut draft JSON file was found in the selected project folder.');
}

async function getProjectDisplayName(projectPath) {
  for (const metaFileName of META_FILE_CANDIDATES) {
    const metaPath = path.join(projectPath, metaFileName);

    if (!(await fileExists(metaPath))) {
      continue;
    }

    try {
      const data = await readJson(metaPath);
      const candidate = data.draft_name || data.project_name || data.name || data.title;

      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    } catch (_error) {
      // Ignore invalid metadata and fall back to folder name.
    }
  }

  return path.basename(projectPath);
}

async function countProjectBackups(projectPath, backupRoot) {
  const backupBase = path.join(backupRoot, sanitizeSegment(path.basename(projectPath)));

  if (!existsSync(backupBase)) {
    return 0;
  }

  const items = await safeReadDir(backupBase);
  return items.filter((item) => item.isDirectory()).length;
}

function parseTextItemContent(textItem) {
  const raw = textItem?.content;
  if (typeof raw !== 'string') return null;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text === 'string') return parsed;
  } catch (_error) {
    // Not valid JSON — not a subtitle entry we can handle.
  }

  return null;
}

function extractCaptionReferences(projectJson) {
  const texts = projectJson?.materials?.texts;

  if (!Array.isArray(texts)) {
    throw new Error('This CapCut project does not contain materials.texts[].');
  }

  const references = [];

  texts.forEach((textItem, index) => {
    const parsedContent = parseTextItemContent(textItem);
    if (parsedContent !== null) {
      references.push({
        index,
        ref: textItem,
        parsedContent
      });
    }
  });

  if (!references.length) {
    throw new Error('No subtitle text entries were found in materials.texts[].content.text.');
  }

  return references;
}

function normalizeCaptionForLineEditor(value) {
  return value.replace(/\r?\n/g, ' ').trimEnd();
}

function splitEditorText(editorText) {
  return editorText.replace(/\r\n/g, '\n').split('\n');
}

// Lightweight stats read from the draft JSON so the project list can show
// clip/image/video/audio counts and duration before the user opens anything.
async function getProjectStats(draftFilePath) {
  try {
    const projectJson = await readJson(draftFilePath);
    const materialMap = buildVideoMaterialMap(projectJson);
    const tracks = Array.isArray(projectJson?.tracks) ? projectJson.tracks : [];

    let clipCount = 0;
    let imageCount = 0;
    let videoCount = 0;
    let audioTrackCount = 0;

    for (const track of tracks) {
      if (track?.type === 'audio') {
        audioTrackCount += 1;
        continue;
      }

      if (track?.type !== 'video') {
        continue;
      }

      for (const segment of track.segments || []) {
        const material = materialMap.get(segment?.material_id);
        if (!isVisualMaterial(material)) {
          continue;
        }
        clipCount += 1;
        if (material.type === 'photo') {
          imageCount += 1;
        } else {
          videoCount += 1;
        }
      }
    }

    return {
      clipCount,
      imageCount,
      videoCount,
      audioTrackCount,
      durationUs: typeof projectJson.duration === 'number' ? projectJson.duration : 0
    };
  } catch (_error) {
    return null;
  }
}

async function scanProjects({ backupRoot }) {
  const projectRoots = getDefaultProjectRoots();
  const projects = [];

  for (const root of projectRoots) {
    if (!existsSync(root)) {
      continue;
    }

    const entries = await safeReadDir(root);

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const projectPath = path.join(root, entry.name);

      try {
        const { draftFileName, draftFilePath } = await resolveDraftFile(projectPath);
        const stats = await fs.stat(projectPath);
        const name = await getProjectDisplayName(projectPath);
        const backupCount = await countProjectBackups(projectPath, backupRoot);
        const projectStats = await getProjectStats(draftFilePath);

        projects.push({
          id: entry.name,
          name,
          path: projectPath,
          draftFileName,
          lastModified: stats.mtime.toISOString(),
          backupCount,
          stats: projectStats
        });
      } catch (_error) {
        // Skip folders that are not CapCut projects.
      }
    }
  }

  projects.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return projects;
}

async function extractCaptions({ projectPath, draftFileName }) {
  const { draftFilePath, draftFileName: resolvedDraftFileName } = await resolveDraftFile(projectPath, draftFileName);
  const projectJson = await readJson(draftFilePath);
  const references = extractCaptionReferences(projectJson);

  let hadEmbeddedNewlines = false;
  const editorLines = references.map(({ parsedContent }) => {
    const originalText = parsedContent.text;
    if (/\r?\n/.test(originalText)) {
      hadEmbeddedNewlines = true;
    }
    return normalizeCaptionForLineEditor(originalText);
  });

  return {
    draftFileName: resolvedDraftFileName,
    captionCount: references.length,
    editorText: editorLines.join('\n'),
    hadEmbeddedNewlines
  };
}

async function createProjectBackup({ projectPath, backupRoot, backupLabel }) {
  const backupId = backupLabel || createBackupId();
  const backupBase = path.join(backupRoot, sanitizeSegment(path.basename(projectPath)), backupId);
  const backupProjectPath = path.join(backupBase, 'project');

  await fs.mkdir(backupBase, { recursive: true });
  await fs.cp(projectPath, backupProjectPath, {
    recursive: true,
    force: true,
    errorOnExist: false
  });

  console.log(`[service] backup created "${backupId}" → ${backupProjectPath}`);

  return {
    backupId,
    backupPath: backupProjectPath
  };
}

async function writeJsonAtomically(targetPath, content) {
  const tempPath = `${targetPath}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, targetPath);
}

async function applyCaptionChanges({ projectPath, draftFileName, editorText, backupRoot }) {
  await assertCapCutClosed();
  const { draftFilePath, draftFileName: resolvedDraftFileName } = await resolveDraftFile(projectPath, draftFileName);
  const projectJson = await readJson(draftFilePath);
  const references = extractCaptionReferences(projectJson);
  const newLines = splitEditorText(editorText);

  if (newLines.length !== references.length) {
    throw new Error(`Line count mismatch. Expected ${references.length} caption lines, but received ${newLines.length}.`);
  }

  const backup = await createProjectBackup({ projectPath, backupRoot });

  references.forEach(({ ref, parsedContent }, index) => {
    parsedContent.text = newLines[index];
    ref.content = JSON.stringify(parsedContent);
  });

  await writeJsonAtomically(draftFilePath, `${JSON.stringify(projectJson, null, 2)}\n`);

  return {
    backupId: backup.backupId,
    draftFileName: resolvedDraftFileName,
    updatedCaptionCount: references.length
  };
}

// ---------------------------------------------------------------------------
// Visual clip helpers (images + video clips) — used by the animation and
// image-sync features. Images are stored as materials.videos[] with type
// "photo"; real footage uses type "video".
// ---------------------------------------------------------------------------

function buildVideoMaterialMap(projectJson) {
  const map = new Map();
  const videos = projectJson?.materials?.videos;

  if (Array.isArray(videos)) {
    for (const material of videos) {
      if (material && typeof material.id === 'string') {
        map.set(material.id, material);
      }
    }
  }

  return map;
}

function isVisualMaterial(material) {
  return Boolean(material) && (material.type === 'photo' || material.type === 'video');
}

function collectVisualSegments(projectJson) {
  const materialMap = buildVideoMaterialMap(projectJson);
  const tracks = Array.isArray(projectJson?.tracks) ? projectJson.tracks : [];
  const collected = [];

  for (const track of tracks) {
    if (track?.type !== 'video') {
      continue;
    }

    const segments = Array.isArray(track.segments) ? track.segments : [];

    for (const segment of segments) {
      const material = materialMap.get(segment?.material_id);
      if (isVisualMaterial(material)) {
        collected.push({ segment, material, track });
      }
    }
  }

  return collected;
}

function buildTextMaterialMap(projectJson) {
  const map = new Map();
  const texts = projectJson?.materials?.texts;

  if (Array.isArray(texts)) {
    for (const material of texts) {
      if (material && typeof material.id === 'string') {
        map.set(material.id, material);
      }
    }
  }

  return map;
}

// Apply a Ken Burns / animation preset to every image and video clip on the
// project's video tracks. Existing scale/position keyframes are overwritten;
// keyframes for unrelated properties (alpha, rotation, volume) are preserved.
async function applyAnimationPreset({ projectPath, draftFileName, presetId, backupRoot }) {
  await assertCapCutClosed();
  const { draftFilePath, draftFileName: resolvedDraftFileName } = await resolveDraftFile(projectPath, draftFileName);
  const projectJson = await readJson(draftFilePath);
  const visualSegments = collectVisualSegments(projectJson);

  console.log(`[service] applyAnimationPreset preset="${presetId}" — ${visualSegments.length} visual clip(s) found`);

  if (!visualSegments.length) {
    throw new Error('No image or video clips were found on the video tracks of this project.');
  }

  const backup = await createProjectBackup({ projectPath, backupRoot });

  let animatedCount = 0;

  for (const { segment } of visualSegments) {
    const durationUs = segment?.target_timerange?.duration;
    if (!(durationUs > 0)) {
      continue;
    }

    // animatedCount doubles as the cycle index so "Cycle" alternates per clip.
    const preset = animationPresets.buildPresetForIndex(presetId, animatedCount, durationUs);

    if (!segment.clip) {
      segment.clip = {};
    }
    segment.clip.scale = { x: preset.scale.x, y: preset.scale.y };
    segment.clip.transform = { x: preset.transform.x, y: preset.transform.y };

    const preserved = (Array.isArray(segment.common_keyframes) ? segment.common_keyframes : []).filter(
      (channel) => !/Position|Scale/i.test(channel?.property_type || '')
    );
    segment.common_keyframes = [...preserved, ...preset.keyframes];

    animatedCount += 1;
  }

  if (!animatedCount) {
    throw new Error('No clips had a valid duration to animate.');
  }

  await writeJsonAtomically(draftFilePath, `${JSON.stringify(projectJson, null, 2)}\n`);

  console.log(`[service] applyAnimationPreset done — animated ${animatedCount} clip(s)`);

  return {
    backupId: backup.backupId,
    draftFileName: resolvedDraftFileName,
    animatedCount
  };
}

// Read CapCut's subtitle (text) track and export it as a timestamped .srt.
// This is read-only and does not modify the project.
async function exportSrt({ projectPath, draftFileName }) {
  const { draftFilePath, draftFileName: resolvedDraftFileName } = await resolveDraftFile(projectPath, draftFileName);
  const projectJson = await readJson(draftFilePath);
  const textMap = buildTextMaterialMap(projectJson);
  const tracks = Array.isArray(projectJson?.tracks) ? projectJson.tracks : [];
  const cues = [];

  for (const track of tracks) {
    if (track?.type !== 'text') {
      continue;
    }

    for (const segment of track.segments || []) {
      const range = segment?.target_timerange;
      if (!range || !(range.duration > 0)) {
        continue;
      }

      const material = textMap.get(segment?.material_id);
      const parsed = parseTextItemContent(material);
      const text = parsed?.text;

      if (typeof text !== 'string' || !text.trim()) {
        continue;
      }

      cues.push({
        start: range.start,
        duration: range.duration,
        text: text.replace(/\r?\n/g, '\n').trim()
      });
    }
  }

  if (!cues.length) {
    throw new Error('No subtitle text with timing was found to export.');
  }

  cues.sort((a, b) => a.start - b.start);

  console.log(`[service] exportSrt — ${cues.length} subtitle cue(s) collected`);

  return {
    draftFileName: resolvedDraftFileName,
    cueCount: cues.length,
    srt: formatSrt(cues)
  };
}

// Shared retiming core used by both Image Sync (SRT) and Audio-Cut Sync.
// Retimes the primary visual track so clip[i] gets cue[i]'s start + duration;
// any leftover clips are laid out contiguously after the last cue. `cues` are
// { start, duration } in microseconds. Returns sync stats. Mutates projectJson.
function retimeClipsToCues(projectJson, cues) {
  const materialMap = buildVideoMaterialMap(projectJson);
  const tracks = Array.isArray(projectJson?.tracks) ? projectJson.tracks : [];

  // Primary visual track = the video track holding the most image/video clips.
  let primaryTrack = null;
  let primaryCount = 0;

  for (const track of tracks) {
    if (track?.type !== 'video') {
      continue;
    }
    const count = (track.segments || []).filter((segment) =>
      isVisualMaterial(materialMap.get(segment?.material_id))
    ).length;
    if (count > primaryCount) {
      primaryCount = count;
      primaryTrack = track;
    }
  }

  if (!primaryTrack) {
    throw new Error('No image or video clips were found to sync.');
  }

  const visualSegments = (primaryTrack.segments || [])
    .filter((segment) => isVisualMaterial(materialMap.get(segment?.material_id)))
    .sort((a, b) => (a?.target_timerange?.start || 0) - (b?.target_timerange?.start || 0));

  const pairCount = Math.min(visualSegments.length, cues.length);
  let cursor = 0;

  for (let i = 0; i < pairCount; i += 1) {
    const segment = visualSegments[i];
    const cue = cues[i];
    const material = materialMap.get(segment.material_id);

    let duration = cue.duration;
    // Real footage cannot play longer than its source; photos are effectively unbounded.
    if (material?.type === 'video' && material.duration > 0) {
      duration = Math.min(duration, material.duration);
    }

    segment.target_timerange = { start: cue.start, duration };

    const sourceStart = segment.source_timerange?.start || 0;
    segment.source_timerange = { start: sourceStart, duration };

    cursor = cue.start + duration;
  }

  // Leftover clips (more clips than cues) are laid out contiguously after the
  // last synced cue, keeping their existing durations.
  for (let i = pairCount; i < visualSegments.length; i += 1) {
    const segment = visualSegments[i];
    const duration = segment?.target_timerange?.duration || 0;
    segment.target_timerange = { start: cursor, duration };
    cursor += duration;
  }

  projectJson.duration =
    typeof projectJson.duration === 'number' ? Math.max(projectJson.duration, cursor) : cursor;

  return {
    syncedCount: pairCount,
    clipCount: visualSegments.length,
    cueCount: cues.length,
    newDuration: cursor
  };
}

// Collect the "cuts" of the primary audio track (the one with the most
// segments) as { start, duration } cues, timeline-ordered.
function collectAudioCues(projectJson) {
  const tracks = Array.isArray(projectJson?.tracks) ? projectJson.tracks : [];

  let primaryTrack = null;
  let primaryCount = 0;

  for (const track of tracks) {
    if (track?.type !== 'audio') {
      continue;
    }
    const count = (track.segments || []).length;
    if (count > primaryCount) {
      primaryCount = count;
      primaryTrack = track;
    }
  }

  if (!primaryTrack) {
    return [];
  }

  return (primaryTrack.segments || [])
    .filter((segment) => segment?.target_timerange && segment.target_timerange.duration > 0)
    .map((segment) => ({
      start: segment.target_timerange.start,
      duration: segment.target_timerange.duration
    }))
    .sort((a, b) => a.start - b.start);
}

// Image Sync with Subtitle — independent of CapCut's own subtitle system.
// Retimes each image/video clip on the primary visual track so that one
// subtitle block (from pasted or uploaded SRT) drives one clip's duration.
// It never creates or edits text/subtitle segments.
async function applyImageSync({ projectPath, draftFileName, srtText, backupRoot }) {
  await assertCapCutClosed();
  const cues = parseSrt(srtText);
  console.log(`[service] applyImageSync — parsed ${cues.length} subtitle block(s) from SRT`);
  const { draftFilePath, draftFileName: resolvedDraftFileName, format } = await resolveDraftFile(projectPath, draftFileName);
  console.log(`[service] applyImageSync — CapCut format: ${format === 'timelines' ? 'new (Timelines)' : 'legacy (root)'} → ${resolvedDraftFileName}`);
  const projectJson = await readJson(draftFilePath);

  const backup = await createProjectBackup({ projectPath, backupRoot });
  const result = retimeClipsToCues(projectJson, cues);

  await writeJsonAtomically(draftFilePath, `${JSON.stringify(projectJson, null, 2)}\n`);

  console.log(
    `[service] applyImageSync done — ${result.syncedCount} clip(s) retimed ` +
      `(${result.clipCount} clip(s) on track vs ${result.cueCount} block(s)), new duration=${result.newDuration}us`
  );

  return {
    backupId: backup.backupId,
    draftFileName: resolvedDraftFileName,
    syncedCount: result.syncedCount,
    clipCount: result.clipCount,
    cueCount: result.cueCount
  };
}

// Audio-Cut Sync — retimes each image/video clip on the primary visual track so
// that one audio segment (a "cut" the user made on the audio track) drives one
// clip's duration. Uses the project's own audio track for timing; no SRT needed.
async function applyAudioSync({ projectPath, draftFileName, backupRoot }) {
  await assertCapCutClosed();
  const { draftFilePath, draftFileName: resolvedDraftFileName, format } = await resolveDraftFile(projectPath, draftFileName);
  console.log(`[service] applyAudioSync — CapCut format: ${format === 'timelines' ? 'new (Timelines)' : 'legacy (root)'} → ${resolvedDraftFileName}`);
  const projectJson = await readJson(draftFilePath);

  const cues = collectAudioCues(projectJson);
  console.log(`[service] applyAudioSync — found ${cues.length} audio cut(s) on the primary audio track`);

  if (!cues.length) {
    throw new Error('No audio cuts were found. Add an audio track and split it into segments in CapCut first.');
  }

  const backup = await createProjectBackup({ projectPath, backupRoot });
  const result = retimeClipsToCues(projectJson, cues);

  await writeJsonAtomically(draftFilePath, `${JSON.stringify(projectJson, null, 2)}\n`);

  console.log(
    `[service] applyAudioSync done — ${result.syncedCount} clip(s) retimed ` +
      `(${result.clipCount} clip(s) vs ${result.cueCount} audio cut(s)), new duration=${result.newDuration}us`
  );

  return {
    backupId: backup.backupId,
    draftFileName: resolvedDraftFileName,
    syncedCount: result.syncedCount,
    clipCount: result.clipCount,
    cueCount: result.cueCount
  };
}

// ---------------------------------------------------------------------------
// Random Apply Transitions — detects the transitions already used at the start
// of the project and re-distributes them randomly across every image/video
// clip. Each applied transition is a full clone of a detected one (duration,
// direction and every other property preserved); only the assignment is random.
// ---------------------------------------------------------------------------

const MAX_DETECTED_TRANSITIONS = 5;

function buildTransitionMaterialMap(projectJson) {
  const map = new Map();
  const transitions = projectJson?.materials?.transitions;

  if (Array.isArray(transitions)) {
    for (const material of transitions) {
      if (material && typeof material.id === 'string') {
        map.set(material.id, material);
      }
    }
  }

  return map;
}

// A stable identity for "the same transition effect + settings" so the first
// five *distinct* transitions are detected even if one is reused early on.
function transitionSignature(material) {
  return [material.effect_id, material.resource_id, material.name, material.duration, material.is_overlap]
    .map((value) => String(value ?? ''))
    .join('|');
}

function newMaterialId() {
  return crypto.randomUUID().toUpperCase();
}

// Timeline-ordered visual segments per video track.
function collectVisualSegmentsByTrack(projectJson) {
  const materialMap = buildVideoMaterialMap(projectJson);
  const tracks = Array.isArray(projectJson?.tracks) ? projectJson.tracks : [];
  const perTrack = [];

  for (const track of tracks) {
    if (track?.type !== 'video') {
      continue;
    }

    const segments = (track.segments || [])
      .filter((segment) => isVisualMaterial(materialMap.get(segment?.material_id)))
      .sort((a, b) => (a?.target_timerange?.start || 0) - (b?.target_timerange?.start || 0));

    if (segments.length) {
      perTrack.push(segments);
    }
  }

  return perTrack;
}

// Detect up to five distinct transitions from the beginning of the project,
// scanning clips in timeline order across the video tracks.
function detectLeadingTransitions(projectJson) {
  const transitionMap = buildTransitionMaterialMap(projectJson);
  const perTrack = collectVisualSegmentsByTrack(projectJson);
  const seen = new Set();
  const detected = [];

  const orderedSegments = perTrack
    .flat()
    .sort((a, b) => (a?.target_timerange?.start || 0) - (b?.target_timerange?.start || 0));

  for (const segment of orderedSegments) {
    for (const refId of segment?.extra_material_refs || []) {
      const material = transitionMap.get(refId);
      if (!material) {
        continue;
      }

      const signature = transitionSignature(material);
      if (!seen.has(signature)) {
        seen.add(signature);
        detected.push(material);
      }

      if (detected.length >= MAX_DETECTED_TRANSITIONS) {
        return detected;
      }
    }
  }

  return detected;
}

async function applyRandomTransitions({ projectPath, draftFileName, backupRoot }) {
  await assertCapCutClosed();
  const { draftFilePath, draftFileName: resolvedDraftFileName } = await resolveDraftFile(projectPath, draftFileName);
  const projectJson = await readJson(draftFilePath);

  const detected = detectLeadingTransitions(projectJson);
  console.log(
    `[service] applyRandomTransitions — detected ${detected.length} transition(s): ` +
      detected.map((t) => t.name || t.effect_id || t.id).join(', ')
  );

  if (!detected.length) {
    throw new Error('No transitions were found at the beginning of the project. Add at least one transition in CapCut first.');
  }

  const perTrack = collectVisualSegmentsByTrack(projectJson);
  if (!perTrack.length) {
    throw new Error('No image or video clips were found on the video tracks of this project.');
  }

  const backup = await createProjectBackup({ projectPath, backupRoot });

  if (!Array.isArray(projectJson.materials.transitions)) {
    projectJson.materials.transitions = [];
  }

  const transitionIds = new Set(buildTransitionMaterialMap(projectJson).keys());
  let appliedCount = 0;

  for (const segments of perTrack) {
    // A transition lives on the outgoing clip, so the last clip of a track
    // has nothing to transition into and is skipped.
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const template = detected[Math.floor(Math.random() * detected.length)];

      // Full clone keeps duration, direction and all other settings intact.
      const clone = JSON.parse(JSON.stringify(template));
      clone.id = newMaterialId();
      projectJson.materials.transitions.push(clone);

      // Replace any existing transition ref; keep refs to other material types.
      const refs = Array.isArray(segment.extra_material_refs) ? segment.extra_material_refs : [];
      segment.extra_material_refs = refs.filter((refId) => !transitionIds.has(refId));
      segment.extra_material_refs.push(clone.id);

      appliedCount += 1;
    }
  }

  if (!appliedCount) {
    throw new Error('Each video track has only one clip — there is nowhere to place a transition.');
  }

  // Drop transition materials that no longer have any segment referencing them.
  const referencedIds = new Set();
  for (const track of projectJson.tracks || []) {
    for (const segment of track.segments || []) {
      for (const refId of segment?.extra_material_refs || []) {
        referencedIds.add(refId);
      }
    }
  }
  projectJson.materials.transitions = projectJson.materials.transitions.filter(
    (material) => referencedIds.has(material?.id)
  );

  await writeJsonAtomically(draftFilePath, `${JSON.stringify(projectJson, null, 2)}\n`);

  console.log(
    `[service] applyRandomTransitions done — applied ${appliedCount} transition(s) ` +
      `from a pool of ${detected.length}`
  );

  return {
    backupId: backup.backupId,
    draftFileName: resolvedDraftFileName,
    detectedCount: detected.length,
    detectedNames: detected.map((t) => t.name || t.effect_id || t.id),
    appliedCount
  };
}

async function emptyDirectory(targetPath) {
  const entries = await safeReadDir(targetPath);

  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    await fs.rm(entryPath, { recursive: true, force: true });
  }
}

async function restoreLatestBackup({ projectPath, backupRoot }) {
  await assertCapCutClosed();
  const projectBackupRoot = path.join(backupRoot, sanitizeSegment(path.basename(projectPath)));
  const entries = await safeReadDir(projectBackupRoot);
  const backups = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();

  if (!backups.length) {
    throw new Error('No backups are available for this project yet.');
  }

  const restoredBackupId = backups[0];
  const restoreSource = path.join(projectBackupRoot, restoredBackupId, 'project');

  if (!(await fileExists(restoreSource))) {
    throw new Error('The latest backup is incomplete and cannot be restored.');
  }

  await createProjectBackup({
    projectPath,
    backupRoot,
    backupLabel: `${createBackupId()}-pre-restore`
  });

  await emptyDirectory(projectPath);
  await fs.cp(restoreSource, projectPath, {
    recursive: true,
    force: true,
    errorOnExist: false
  });

  console.log(`[service] restored project from backup "${restoredBackupId}"`);

  return {
    restoredBackupId
  };
}

module.exports = {
  scanProjects,
  extractCaptions,
  createProjectBackup,
  applyCaptionChanges,
  restoreLatestBackup,
  applyAnimationPreset,
  exportSrt,
  applyImageSync,
  applyRandomTransitions,
  applyAudioSync,
  killCapCut,
  clearProjectCache,
  listAnimationPresets: animationPresets.listPresets
};
