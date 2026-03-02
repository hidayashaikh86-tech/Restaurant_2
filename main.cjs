const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let autoUpdater = null;
let updaterLogger = console;

try {
    const electronLog = require('electron-log');
    electronLog.transports.file.level = 'info';
    updaterLogger = electronLog;
} catch (error) {
    console.warn('electron-log not available; update logs will use console only.');
}

try {
    ({ autoUpdater } = require('electron-updater'));
} catch (error) {
    console.warn('electron-updater not available; desktop auto-update is disabled.', error.message);
}

let mainWindow = null;
let backendServer = null;
let shutdownPromise = null;
let isQuitting = false;
let isQuittingForUpdate = false;
let updateCheckTimer = null;
const backendPort = Number(process.env.PORT || 3000);
const UPDATE_CONFIG_PLACEHOLDER = 'YOUR-UPDATE-DOMAIN';

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
}

function resolveUpdateConfigPath() {
    const packagedPath = path.join(process.resourcesPath, 'desktop', 'update-config.json');
    const localPath = path.join(__dirname, 'update-config.json');
    return fs.existsSync(packagedPath) ? packagedPath : localPath;
}

function loadUpdateConfig() {
    const envUrl = (process.env.DESKTOP_UPDATE_URL || '').trim();
    let fileConfig = {};

    const configPath = resolveUpdateConfigPath();
    if (fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (error) {
            updaterLogger.error(`Failed to parse update config at ${configPath}:`, error);
        }
    }

    const config = {
        provider: fileConfig.provider || 'generic',
        url: envUrl || (fileConfig.url || '').trim(),
        channel: fileConfig.channel || 'latest',
        autoDownload: fileConfig.autoDownload !== false,
        checkIntervalMinutes: Number(fileConfig.checkIntervalMinutes || 240)
    };

    if (!config.url || config.url.includes(UPDATE_CONFIG_PLACEHOLDER)) {
        return null;
    }

    return config;
}

async function startBackend() {
    const serverPath = path.join(__dirname, '..', 'server.js');
    const serverModule = await import(pathToFileURL(serverPath).href);
    backendServer = await serverModule.startServer(backendPort);
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1100,
        minHeight: 700,
        autoHideMenuBar: true,
        title: 'QuickServe Restaurant',
        webPreferences: {
            contextIsolation: true,
            sandbox: true
        }
    });

    const appUrl = `http://127.0.0.1:${backendPort}/index10.html?desktop=1`;
    mainWindow.loadURL(appUrl);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        const localHost127 = `http://127.0.0.1:${backendPort}`;
        const localHostName = `http://localhost:${backendPort}`;
        const isLocalAppWindow = url === 'about:blank' || url.startsWith(localHost127) || url.startsWith(localHostName);

        // Allow internal popup windows used by billing receipt/print flows.
        if (isLocalAppWindow) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 420,
                    height: 700,
                    autoHideMenuBar: true,
                    title: 'QuickServe Print',
                    webPreferences: {
                        contextIsolation: true,
                        sandbox: true
                    }
                }
            };
        }

        // Open external links in the system browser and swallow OS-level open errors.
        shell.openExternal(url).catch((error) => {
            console.error(`Failed to open external URL: ${url}`, error);
        });
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function stopUpdateChecks() {
    if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
    }
}

function scheduleUpdateChecks(intervalMinutes = 240) {
    stopUpdateChecks();
    const safeIntervalMinutes = Math.max(30, Number(intervalMinutes) || 240);
    const intervalMs = safeIntervalMinutes * 60 * 1000;
    updateCheckTimer = setInterval(() => {
        if (!autoUpdater || !app.isPackaged || isQuitting) return;
        autoUpdater.checkForUpdates().catch((error) => {
            updaterLogger.error('Scheduled update check failed:', error);
        });
    }, intervalMs);
}

async function installDownloadedUpdate() {
    if (!autoUpdater) return;
    try {
        isQuittingForUpdate = true;
        await shutdownBackend();
    } catch (error) {
        updaterLogger.error('Failed to stop backend before update install:', error);
    }
    autoUpdater.quitAndInstall(false, true);
}

function setupAutoUpdater() {
    if (!app.isPackaged) {
        updaterLogger.info('Auto-update skipped in development mode.');
        return;
    }

    if (!autoUpdater) {
        updaterLogger.warn('Auto-update unavailable because electron-updater is not installed.');
        return;
    }

    const updateConfig = loadUpdateConfig();
    if (!updateConfig) {
        updaterLogger.warn('Auto-update disabled: configure desktop/update-config.json or DESKTOP_UPDATE_URL.');
        return;
    }

    autoUpdater.logger = updaterLogger;
    autoUpdater.autoDownload = updateConfig.autoDownload;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.setFeedURL({
        provider: updateConfig.provider,
        url: updateConfig.url,
        channel: updateConfig.channel
    });

    autoUpdater.on('checking-for-update', () => {
        updaterLogger.info('Checking for app updates...');
    });

    autoUpdater.on('update-available', (info) => {
        updaterLogger.info(`Update available: ${info?.version || 'unknown version'}`);
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `QuickServe ${info?.version || ''} is available.`,
            detail: updateConfig.autoDownload
                ? 'The update is downloading in the background. You will be prompted to restart after download.'
                : 'Download will begin when you confirm from updater controls.',
            buttons: ['OK']
        }).catch((error) => {
            updaterLogger.error('Failed to show update-available dialog:', error);
        });
    });

    autoUpdater.on('update-not-available', (info) => {
        updaterLogger.info(`No update available. Current version: ${info?.version || app.getVersion()}`);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        const percent = Number(progressObj?.percent || 0).toFixed(1);
        updaterLogger.info(`Update download progress: ${percent}%`);
    });

    autoUpdater.on('update-downloaded', async (info) => {
        updaterLogger.info(`Update downloaded: ${info?.version || 'unknown version'}`);

        const targetWindow = BrowserWindow.getFocusedWindow() || mainWindow;
        const { response } = await dialog.showMessageBox(targetWindow || null, {
            type: 'info',
            title: 'Install Update',
            message: `QuickServe ${info?.version || ''} is ready to install.`,
            detail: 'Restart now to apply the update.',
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
            cancelId: 1
        });

        if (response === 0) {
            await installDownloadedUpdate();
        }
    });

    autoUpdater.on('error', (error) => {
        updaterLogger.error('Auto-updater error:', error);
    });

    setTimeout(() => {
        if (isQuitting) return;
        autoUpdater.checkForUpdates().catch((error) => {
            updaterLogger.error('Initial update check failed:', error);
        });
    }, 5000);

    scheduleUpdateChecks(updateConfig.checkIntervalMinutes);
    updaterLogger.info(`Auto-update enabled. Feed URL: ${updateConfig.url}`);
}

function shutdownBackend() {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = new Promise((resolve) => {
        if (!backendServer) {
            resolve();
            return;
        }
        backendServer.close(() => {
            backendServer = null;
            resolve();
        });
    });

    return shutdownPromise;
}

if (gotSingleInstanceLock) {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        Menu.setApplicationMenu(null);
        await startBackend();
        createMainWindow();
        setupAutoUpdater();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createMainWindow();
            }
        });
    }).catch((error) => {
        const details = error && error.code === 'EADDRINUSE'
            ? `Port ${backendPort} is already in use.\nClose any running QuickServe app and try again.`
            : error.message;
        dialog.showErrorBox('QuickServe Launch Error', `Failed to start desktop app.\n\n${details}`);
        app.quit();
    });
}

app.on('before-quit', (event) => {
    stopUpdateChecks();

    if (isQuittingForUpdate) {
        return;
    }

    if (isQuitting) {
        return;
    }

    event.preventDefault();
    isQuitting = true;
    shutdownBackend().finally(() => {
        app.quit();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
