import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import { join } from 'path';
import { spawn } from 'child_process';
import http from 'http';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridgeProcess: ReturnType<typeof spawn> | null = null;
let isQuitting = false;

function appRoot(): string {
  return app.isPackaged ? join(__dirname, '..', '..') : join(__dirname, '..', '..');
}

function bridgeEntry(): string {
  return join(__dirname, '..', 'index.js');
}

function userDataPath(file: string): string {
  return join(app.getPath('userData'), file);
}

function bridgePort(): number {
  const port = Number.parseInt(process.env.BRIDGE_PORT || '9876', 10);
  return Number.isFinite(port) ? port : 9876;
}

function waitForConfigUi(port: number, attempts = 40): void {
  const tryLoad = (left: number) => {
    const req = http.get(`http://127.0.0.1:${port}/api/status`, (res) => {
      res.resume();
      mainWindow?.loadURL(`http://127.0.0.1:${port}`);
    });
    req.on('error', () => {
      if (left <= 0) {
        mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<h2>Agent Bridge is starting...</h2><p>Please reopen this window in a few seconds.</p>')}`);
        return;
      }
      setTimeout(() => tryLoad(left - 1), 500);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      if (left <= 0) return;
      setTimeout(() => tryLoad(left - 1), 500);
    });
  };
  tryLoad(attempts);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'Agent Bridge',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    // macOS: 隐藏而非关闭
    ...(process.platform === 'darwin' ? {} : {}),
  });

  waitForConfigUi(bridgePort());

  mainWindow.on('close', (event) => {
    if (tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  // 创建一个简单的托盘图标 (16x16 绿色圆点)
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: '重启桥接',
      click: () => {
        restartBridge();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Agent Bridge');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function startBridge(): void {
  const envFile = app.isPackaged ? userDataPath('.env') : join(appRoot(), '.env');
  bridgeProcess = spawn(process.execPath, [bridgeEntry()], {
    cwd: app.isPackaged ? app.getPath('userData') : appRoot(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BRIDGE_CONFIG_FILE: userDataPath('.bridge-config.json'),
      BRIDGE_ENV_FILE: envFile,
    },
    stdio: 'pipe',
  });

  bridgeProcess.stdout?.on('data', (data) => {
    console.log(`[bridge] ${data}`);
  });

  bridgeProcess.stderr?.on('data', (data) => {
    console.error(`[bridge] ${data}`);
  });

  bridgeProcess.on('close', (code) => {
    console.log(`Bridge process exited with code ${code}`);
    bridgeProcess = null;
    if (!isQuitting) setTimeout(() => startBridge(), 2000);
  });
}

function restartBridge(): void {
  if (bridgeProcess) {
    bridgeProcess.kill();
    bridgeProcess = null;
  }
  setTimeout(() => startBridge(), 500);
}

app.whenReady().then(() => {
  startBridge();
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  // macOS 不退出，保持托盘运行
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (bridgeProcess) {
    bridgeProcess.kill();
    bridgeProcess = null;
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
