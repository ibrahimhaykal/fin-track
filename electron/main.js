// Desktop shell: runs the Express API + built dashboard in-process and shows it in a window.
// Closing the window hides it to the tray (crypto prices keep refreshing); quit from the tray menu.
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Own port so the desktop app can run next to `npm run dev` (which uses 5000).
const PORT = process.env.APP_PORT || '5123';
const URL = `http://127.0.0.1:${PORT}`;
const startHidden = process.argv.includes('--hidden'); // used by "open at login"

let win = null;
let tray = null;
let quitting = false;

// Windows only shows notifications (budget alerts) for an app with an AppUserModelID; it is also the toast's title.
app.setAppUserModelId('Celengin');

if (!app.requestSingleInstanceLock()) {
  // Already running: that instance brings its window to the front (see 'second-instance').
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => (quitting = true));
  app.whenReady().then(start);
}

async function start() {
  // Packaged apps keep writable data outside the installation directory.
  const dataDir = app.isPackaged ? app.getPath('userData') : ROOT;
  process.chdir(dataDir);
  process.env.DOTENV_CONFIG_PATH = path.join(dataDir, '.env');
  process.env.APP_DIST = path.join(ROOT, 'dist');
  process.env.PORT = PORT;
  process.env.HOST = '127.0.0.1';
  // Lets the server restart the app after a restore (the restored database is swapped in on start).
  globalThis.celenginRestart = () => {
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
    app.exit(0);
  };
  await import('../server.js');
  await waitForServer();

  createTray();
  createWindow();
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${URL}/api/dashboard`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start on ${URL}`);
}

// Page background for the current OS theme (same as --color-zinc-950 in index.css), so there is no flash on open.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#09090b' : '#f4f4f5');

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 380,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground(),
    title: 'Celengin',
    icon: path.join(ROOT, 'electron', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(URL);
  // Windows switched light <-> dark: the page follows via prefers-color-scheme; match the window behind it.
  nativeTheme.on('updated', () => win?.setBackgroundColor(windowBackground()));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });

  // Links to other sites open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Close = hide to tray, so the app keeps running in the background.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const openAtLogin = () => app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin;
// When started as `electron .`, the app folder has to be passed along to the login item.
const loginArgs = () => (app.isPackaged ? ['--hidden'] : [ROOT, '--hidden']);

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'electron', 'tray.png')));
  tray.setToolTip('Celengin');
  tray.on('click', showWindow);
  const rebuild = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Buka Celengin', click: showWindow },
        { label: 'Buka folder data', click: () => shell.openPath(app.isPackaged ? app.getPath('userData') : ROOT) },
        {
          label: 'Refresh',
          click: () => {
            showWindow();
            win?.webContents.reload();
          },
        },
        { type: 'separator' },
        {
          label: 'Buka otomatis saat Windows nyala',
          type: 'checkbox',
          checked: openAtLogin(),
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: loginArgs() });
            rebuild();
          },
        },
        {
          label: 'Lupa PIN? Reset PIN',
          click: async () => {
            const { response } = await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Batal', 'Reset PIN'],
              defaultId: 0,
              cancelId: 0,
              title: 'Reset PIN',
              message: 'Hapus PIN Celengin?',
              detail: 'Celengin bakal kebuka tanpa PIN. Data kamu nggak kehapus.',
            });
            if (response !== 1) return;
            globalThis.celenginResetPin?.();
            showWindow();
            win?.webContents.reload();
          },
        },
        { type: 'separator' },
        {
          // Picks up code changes (server.js / a new build); closing the window only hides it to the tray.
          label: 'Restart Celengin',
          click: () => {
            app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
            app.exit(0);
          },
        },
        { label: 'Keluar', click: () => app.quit() },
      ])
    );
  rebuild();
}
