const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const projectService = require('./src/project-service');

let mainWindow;

// Forward every main-process console line to the renderer's Log Panel.
// Level: 'info' | 'warning' | 'error' | 'success'.
function sendLogToWindow(level, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:log', { level, message, at: Date.now() });
  }
}

// Patch console so existing [service]/[ipc] logging lands in the Log Panel too.
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function stringifyArgs(args) {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
}

console.log = (...args) => {
  originalConsole.log(...args);
  const message = stringifyArgs(args);
  sendLogToWindow(/✓|done|created|restored/.test(message) ? 'success' : 'info', message);
};
console.warn = (...args) => {
  originalConsole.warn(...args);
  sendLogToWindow('warning', stringifyArgs(args));
};
console.error = (...args) => {
  originalConsole.error(...args);
  sendLogToWindow('error', stringifyArgs(args));
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'CapCut Automation Studio',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function getBackupRoot() {
  return path.join(app.getPath('userData'), 'project-backups');
}

function validateProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new Error('A valid project path is required.');
  }

  return projectPath;
}

// Trim payloads/results down to something readable for the log (never dump the
// full draft JSON or long caption/SRT text).
function summarize(value) {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && val.length > 60) {
      out[key] = `${val.slice(0, 57)}… (${val.length} chars)`;
    } else if (Array.isArray(val)) {
      out[key] = `[${val.length} items]`;
    } else {
      out[key] = val;
    }
  }
  return out;
}

// Wrap ipcMain.handle so every channel logs its call, timing, and outcome.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload = {}) => {
    const startedAt = Date.now();
    console.log(`[ipc] → ${channel}`, summarize(payload));

    try {
      const result = await fn(event, payload);
      console.log(`[ipc] ✓ ${channel} (${Date.now() - startedAt}ms)`, summarize(result));
      return result;
    } catch (error) {
      console.error(`[ipc] ✗ ${channel} (${Date.now() - startedAt}ms): ${error.message}`);
      throw error;
    }
  });
}

app.whenReady().then(() => {
  console.log(`[app] ready — userData=${app.getPath('userData')}`);
  console.log(`[app] backup root=${getBackupRoot()}`);
  createWindow();

  handle('projects:scan', async () => {
    return projectService.scanProjects({ backupRoot: getBackupRoot() });
  });

  handle('projects:extract-captions', async (_event, payload = {}) => {
    return projectService.extractCaptions({
      projectPath: validateProjectPath(payload.projectPath),
      draftFileName: payload.draftFileName
    });
  });

  handle('projects:backup', async (_event, payload = {}) => {
    return projectService.createProjectBackup({
      projectPath: validateProjectPath(payload.projectPath),
      backupRoot: getBackupRoot()
    });
  });

  handle('projects:restore-backup', async (_event, payload = {}) => {
    const projectPath = validateProjectPath(payload.projectPath);

    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Restore Latest Backup', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Restore Backup',
      message: 'Restore the latest backup for this project?',
      detail: 'The current project folder will be replaced with the latest saved backup. A safety backup of the current state will be created first.'
    });

    if (answer.response !== 0) {
      return { cancelled: true };
    }

    return projectService.restoreLatestBackup({
      projectPath,
      backupRoot: getBackupRoot()
    });
  });

  handle('projects:apply-changes', async (_event, payload = {}) => {
    const projectPath = validateProjectPath(payload.projectPath);

    if (typeof payload.editorText !== 'string') {
      throw new Error('Edited caption text is required.');
    }

    return projectService.applyCaptionChanges({
      projectPath,
      draftFileName: payload.draftFileName,
      editorText: payload.editorText,
      backupRoot: getBackupRoot()
    });
  });

  handle('projects:list-animation-presets', async () => {
    return projectService.listAnimationPresets();
  });

  handle('projects:apply-animation', async (_event, payload = {}) => {
    const projectPath = validateProjectPath(payload.projectPath);

    if (typeof payload.presetId !== 'string' || !payload.presetId.trim()) {
      throw new Error('An animation preset must be selected.');
    }

    return projectService.applyAnimationPreset({
      projectPath,
      draftFileName: payload.draftFileName,
      presetId: payload.presetId,
      backupRoot: getBackupRoot()
    });
  });

  handle('projects:random-transitions', async (_event, payload = {}) => {
    return projectService.applyRandomTransitions({
      projectPath: validateProjectPath(payload.projectPath),
      draftFileName: payload.draftFileName,
      backupRoot: getBackupRoot()
    });
  });

  handle('projects:export-srt', async (_event, payload = {}) => {
    return projectService.exportSrt({
      projectPath: validateProjectPath(payload.projectPath),
      draftFileName: payload.draftFileName
    });
  });

  handle('projects:audio-sync', async (_event, payload = {}) => {
    return projectService.applyAudioSync({
      projectPath: validateProjectPath(payload.projectPath),
      draftFileName: payload.draftFileName,
      backupRoot: getBackupRoot()
    });
  });

  handle('capcut:kill', async () => {
    return projectService.killCapCut();
  });

  handle('projects:clear-cache', async (_event, payload = {}) => {
    return projectService.clearProjectCache({
      projectPath: validateProjectPath(payload.projectPath)
    });
  });

  handle('projects:image-sync', async (_event, payload = {}) => {
    const projectPath = validateProjectPath(payload.projectPath);

    if (typeof payload.srtText !== 'string' || !payload.srtText.trim()) {
      throw new Error('Subtitle text (SRT format with timestamps) is required.');
    }

    return projectService.applyImageSync({
      projectPath,
      draftFileName: payload.draftFileName,
      srtText: payload.srtText,
      backupRoot: getBackupRoot()
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
