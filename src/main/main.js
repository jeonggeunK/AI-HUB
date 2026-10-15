'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BaseWindow, WebContentsView, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, shell, dialog } = require('electron');
const { CHROME_UA } = require('./security');
const { validateFiles, MAX_FILE_BYTES } = require('./attach');

const { Hub } = require('./hub');
const updater = require('./updater');
const store = require('./store');

// ───────────── 첨부 파일 ─────────────

const attachTempRoot = () => path.join(app.getPath('temp'), 'aihub-attach');

// 사용자가 실제로 고른 파일만 보낼 수 있다(파일 선택 창·끌어다 놓기·붙여넣기).
// 렌더러가 임의의 경로를 넘겨 다른 파일을 올리게 하는 일을 막는다.
// 같은 파일을 여러 번 첨부할 수 있으므로(전송 중에 다음 질문에 또 첨부 등) 경로마다 사용 횟수를 센다.
const attachable = new Map(); // 경로 -> 등록 횟수
const isAttachable = (p) => attachable.has(p);

/** 첨부 가능한 파일만 {path, name, size}로 — 그리고 보낼 수 있는 목록에 등록(횟수 +1) */
function registerFiles(paths) {
  return validateFiles(paths).map((p) => {
    attachable.set(p, (attachable.get(p) || 0) + 1);
    return { path: p, name: path.basename(p), size: fs.statSync(p).size };
  });
}

const tempDirs = new Map(); // 붙여넣기로 앱이 직접 만든 임시 파일 경로 -> 그 파일만 담은 폴더

/** 첨부를 빼거나 보낸 뒤: 횟수 -1, 0이 되면 등록 해제하고 앱이 만든 임시 파일이면 그 폴더만 삭제 */
function discardFiles(paths) {
  for (const raw of paths) {
    const p = path.resolve(raw);
    const n = attachable.get(p);
    if (!n) continue; // 등록된 적 없는 경로는 무시
    if (n > 1) { attachable.set(p, n - 1); continue; }
    attachable.delete(p);
    const dir = tempDirs.get(p);
    if (dir) {
      tempDirs.delete(p);
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const DEV = process.argv.includes('--dev');
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// 모든 세션의 기본 UA에서 Electron 흔적 제거 (팝업 창 포함)
app.userAgentFallback = CHROME_UA;
// Windows 알림(토스트)이 표시되려면 앱 ID가 필요 — package.json의 build.appId와 같게
app.setAppUserModelId('local.aihub.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let hub = null;
  let tray = null;
  let quitting = false;
  let registeredHotkey = '';

  app.on('second-instance', () => showWindow());

  function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  /** 전역 단축키: 앱이 앞에 있으면 숨기고, 아니면 불러와서 질문 입력창에 포커스 */
  function toggleQuickAsk() {
    if (!win || !hub) return;
    if (win.isVisible() && win.isFocused() && !win.isMinimized()) {
      if (hub.settings.closeToTray) win.hide();
      else win.minimize();
      return;
    }
    showWindow();
    hub.quickAsk();
  }

  // ───────────── 설정 반영 ─────────────

  function applyHotkey() {
    const wanted = hub ? hub.settings.globalHotkey : '';
    if (wanted === registeredHotkey) return;
    if (!wanted) {
      globalShortcut.unregister(registeredHotkey);
      registeredHotkey = '';
      return;
    }
    // 새 단축키를 먼저 등록해 보고, 성공했을 때만 이전 것을 해제 — 실패해도 쓰던 단축키는 살아 있다
    if (globalShortcut.register(wanted, toggleQuickAsk)) {
      if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
      registeredHotkey = wanted;
      return;
    }
    hub.settings.globalHotkey = registeredHotkey;
    store.save();
    hub.pushState();
    hub.toast(`전역 단축키(${wanted})를 등록하지 못했습니다. 다른 프로그램이 사용 중일 수 있습니다.`, 'warn');
  }

  function applyTray() {
    const want = hub && hub.settings.closeToTray;
    if (!want) {
      if (tray) tray.destroy();
      tray = null;
      return;
    }
    if (tray) return;
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('AI Hub');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '열기', click: showWindow },
      { label: '빠른 질문', click: () => { showWindow(); hub && hub.quickAsk(); } },
      { label: '설정', click: () => { showWindow(); hub && hub.openSettings('general'); } },
      { type: 'separator' },
      { label: '종료', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  }

  function applySettings(keys) {
    if (!win || !hub) return;
    if (!keys || keys.includes('alwaysOnTop')) win.setAlwaysOnTop(hub.settings.alwaysOnTop);
    if (!keys || keys.includes('globalHotkey')) applyHotkey();
    if (!keys || keys.includes('closeToTray')) applyTray();
  }

  // ───────────── 창 ─────────────

  function boundsAreVisible(b) {
    if (!Number.isInteger(b.x) || !Number.isInteger(b.y)) return false;
    return screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 10 && b.y < a.y + a.height - 100);
  }

  function createWindow() {
    const st = store.get();
    const area = screen.getDisplayMatching(boundsAreVisible(st.bounds) ? st.bounds : screen.getPrimaryDisplay().workArea).workArea;
    const size = { width: Math.min(st.bounds.width, area.width), height: Math.min(st.bounds.height, area.height) };
    const bounds = boundsAreVisible(st.bounds) ? { ...st.bounds, ...size } : size;

    win = new BaseWindow({
      ...bounds,
      minWidth: 640,
      minHeight: 420,
      title: 'AI Hub',
      icon: nativeImage.createFromPath(ICON),
      backgroundColor: '#1b1c1f',
      autoHideMenuBar: true,
    });
    if (st.maximized) win.maximize();

    const ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'ui.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    ui.setBackgroundColor('#00000000'); // 오버레이(설정 화면) 때 뒤의 페이지가 비쳐 보이도록
    win.contentView.addChildView(ui);

    hub = new Hub(win, ui, { dev: DEV, onSettingsChanged: applySettings });

    ui.webContents.on('before-input-event', (e, input) => hub.handleShortcut(e, input));
    ui.webContents.on('will-navigate', (e) => e.preventDefault());
    ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    ui.webContents.on('did-finish-load', () => {
      hub.layout();
      hub.pushState();
      hub.focusActive();
      hub.preloadOthers();
      if (!store.get().onboarded) hub.openWelcome();
      // UI 확인용: --settings 또는 --settings=accounts
      const settingsArg = DEV && process.argv.find((a) => a.startsWith('--settings'));
      if (settingsArg) hub.openSettings(settingsArg.split('=')[1] || 'general');
    });
    ui.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    const saveBounds = () => {
      if (win.isDestroyed()) return;
      st.maximized = win.isMaximized();
      if (!st.maximized && !win.isMinimized()) st.bounds = win.getBounds();
      store.save();
    };
    win.on('resize', () => { hub.layout(); saveBounds(); });
    win.on('move', saveBounds);
    win.on('maximize', saveBounds);
    win.on('unmaximize', saveBounds);
    win.on('focus', () => hub.focusActive());
    win.on('close', (e) => {
      // "닫으면 트레이로" 설정이면 종료하지 않고 숨긴다(답변 스트리밍과 로그인 유지)
      if (!quitting && hub && hub.settings.closeToTray) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      hub.destroyAll();
      if (!ui.webContents.isDestroyed()) ui.webContents.close();
      store.flush();
      win = null;
      hub = null;
    });

    applySettings();
  }

  // ───────────── IPC ─────────────

  // IPC는 앱 수명 동안 한 번만 등록하고, 현재 창의 UI 뷰가 보낸 메시지만 처리한다
  function registerIpc() {
    const guard = (fn) => (event, ...args) => {
      if (!hub || event.sender !== hub.ui.webContents) return undefined;
      return fn(...args);
    };
    const str = (v) => (typeof v === 'string' ? v : '');
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const strs = (v) => (Array.isArray(v) ? v.map(str) : []);

    ipcMain.handle('hub:get-state', guard(() => hub.snapshot()));
    ipcMain.on('hub:select-service', guard((id) => hub.selectService(str(id))));
    ipcMain.on('hub:account-menu', guard((id, x, y) => hub.showAccountMenu(str(id), num(x), num(y))));
    ipcMain.on('hub:split-menu', guard((x, y) => hub.showSplitMenu(num(x), num(y))));
    ipcMain.on('hub:nav', guard((action) => hub.nav(str(action))));
    ipcMain.on('hub:new-chat', guard((id) => hub.newChat(str(id))));
    ipcMain.on('hub:new-chat-all', guard(() => hub.newChatAll()));
    ipcMain.on('hub:check-update', guard(() => updater.check(true)));
    ipcMain.on('hub:install-update', guard(() => updater.installNow(() => { quitting = true; })));
    ipcMain.on('hub:toggle-layout', guard(() => hub.toggleLayout()));
    ipcMain.on('hub:toggle-broadcast', guard(() => hub.toggleBroadcast()));
    ipcMain.on('hub:set-overlay', guard((on) => hub.setOverlay(on === true)));
    ipcMain.on('hub:zoom', guard((dir) => hub.zoom(Math.sign(num(dir)))));
    ipcMain.on('hub:bar-height', guard((h) => hub.setBarHeight(num(h))));
    ipcMain.on('hub:composer-height', guard((h) => hub.setComposerHeight(Number.isFinite(h) ? h : null)));
    ipcMain.on('hub:set-targets', guard((ids) => hub.setBroadcastTargets(strs(ids))));
    ipcMain.on('hub:open-settings', guard((section) => hub.openSettings(str(section))));
    ipcMain.on('hub:update-settings', guard((patch) => hub.updateSettings(patch)));
    ipcMain.handle('hub:set-shortcut', guard((id, combo) => hub.setShortcut(str(id), combo === null ? null : str(combo))));
    ipcMain.on('hub:clear-history', guard(() => hub.clearHistory()));
    ipcMain.on('hub:rename-account', guard((id, label) => hub.renameAccount(str(id), str(label))));
    ipcMain.on('hub:account-action', guard((action, id) => hub.accountAction(str(action), str(id))));
    ipcMain.on('hub:open-data-folder', guard(() => shell.openPath(app.getPath('userData'))));
    ipcMain.on('hub:toggle-sidebar', guard(() => hub.toggleSidebar()));
    ipcMain.handle('hub:open-history', guard((id, serviceId) => hub.openHistory(str(id), str(serviceId) || null)));
    ipcMain.on('hub:delete-history', guard((id) => hub.deleteHistory(str(id))));
    ipcMain.on('hub:set-order', guard((ids) => hub.setServiceOrder(strs(ids))));
    ipcMain.on('hub:move-service', guard((id, step) => hub.moveService(str(id), Math.sign(num(step)))));
    ipcMain.on('hub:open-welcome', guard(() => hub.openWelcome()));
    ipcMain.on('hub:complete-onboarding', guard((ids) => hub.completeOnboarding(Array.isArray(ids) ? strs(ids) : null)));
    ipcMain.handle('hub:get-version', guard(() => ({
      app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    })));
    ipcMain.handle('hub:broadcast', guard((text, ids, opts) =>
      hub.sendBroadcast(str(text).slice(0, 100000), strs(ids), {
        newChat: !!(opts && opts.newChat === true),
        // 등록되지 않은 경로(사용자가 고르지 않은 파일)는 버린다 — hub가 개수 불일치로 전송을 막는다
        files: opts && Array.isArray(opts.files) ? strs(opts.files).filter((p) => isAttachable(path.resolve(p))) : [],
        requestedFiles: opts && Array.isArray(opts.files) ? opts.files.length : 0,
      })));
    ipcMain.on('hub:discard-files', guard((paths) => discardFiles(strs(paths))));

    // 첨부: 📎 버튼 — 파일 선택 창
    ipcMain.handle('hub:pick-files', guard(async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(hub.win, {
        title: '첨부할 파일 선택',
        properties: ['openFile', 'multiSelections'],
      });
      return canceled ? [] : registerFiles(filePaths);
    }));
    // 첨부: 경로가 없는 파일(클립보드에서 붙여넣은 캡처 이미지 등)은 임시 파일로 저장해서 경로를 만든다
    ipcMain.handle('hub:save-temp-file', guard(async (name, bytes) => {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return null;
      const safe = (str(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)) || 'pasted.png';
      const dir = path.join(attachTempRoot(), crypto.randomUUID());
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, safe);
      await fs.promises.writeFile(file, bytes);
      const info = registerFiles([file])[0] || null;
      if (info) tempDirs.set(info.path, dir);
      else await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      return info;
    }));
    // 첨부: 끌어다 놓은 파일 — preload가 webUtils로 얻은 실제 경로만 온다(페이지 스크립트는 이 채널을 직접 못 씀)
    ipcMain.handle('hub:file-infos', guard((paths) => registerFiles(strs(paths))));
  }

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    Hub.cleanupLoginProfiles(); // 비정상 종료로 남은 일회용 로그인 프로필 정리
    fs.promises.rm(attachTempRoot(), { recursive: true, force: true }).catch(() => {}); // 지난번 붙여넣기 임시 파일 정리
    registerIpc();
    createWindow();
    updater.init({
      enabled: () => !hub || hub.settings.autoUpdate,
      onChange: () => hub && hub.pushState(),
      toast: (msg, kind) => hub && hub.toast(msg, kind, 'top', 12000),
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    store.flush();
    try { fs.rmSync(attachTempRoot(), { recursive: true, force: true }); } catch { /* 다음 시작 때 정리 */ }
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); updater.stop(); });
  app.on('window-all-closed', () => app.quit());
}
