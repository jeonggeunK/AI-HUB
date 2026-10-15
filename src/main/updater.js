'use strict';
/**
 * 자동 업데이트 (electron-updater + GitHub Releases).
 * - 시작 10초 뒤, 그리고 4시간마다 새 버전 확인 → 있으면 백그라운드에서 내려받는다(바뀐 부분만)
 * - 다 받으면 상단바에 "업데이트 — 재시작" 버튼. 누르지 않아도 다음에 앱을 끌 때 설치된다
 * - 개발 중(npm start)에는 동작하지 않는다 — 설치된 앱(app.isPackaged)에서만
 */
const { app } = require('electron');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** UI에 보여 줄 상태: idle | checking | latest | downloading | ready | error | dev */
const status = { state: app.isPackaged ? 'idle' : 'dev', version: null, percent: 0, error: null };

let autoUpdater = null;
let notify = () => {};
let toast = () => {};
let timer = null;
let manual = false; // 사용자가 "업데이트 확인"을 눌렀을 때만 "최신입니다"·오류를 알린다

function set(patch) {
  Object.assign(status, patch);
  notify();
}

/**
 * @param {{ enabled: () => boolean, onChange: () => void, toast: (msg: string, kind?: string) => void }} opts
 */
function init(opts) {
  notify = opts.onChange;
  toast = opts.toast;
  if (!app.isPackaged) return;

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // 재시작을 안 눌러도 다음 종료 때 설치
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => {
    set({ state: 'latest' });
    if (manual) toast(`최신 버전입니다 (${app.getVersion()}).`, 'ok');
    manual = false;
  });
  autoUpdater.on('update-available', (info) => {
    set({ state: 'downloading', version: info.version, percent: 0 });
    toast(`새 버전 ${info.version}을(를) 내려받는 중입니다…`);
    manual = false;
  });
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ state: 'ready', version: info.version, percent: 100 });
    toast(`새 버전 ${info.version} 준비 완료 — 상단의 "업데이트" 버튼을 누르거나, 다음에 앱을 끌 때 설치됩니다.`, 'ok');
  });
  autoUpdater.on('error', (err) => {
    // 인터넷이 끊겼거나 아직 올린 버전이 없을 때 등 — 자동 확인 중이면 조용히 넘어간다
    set({ state: 'error', error: err ? err.message : '알 수 없는 오류' });
    if (manual) toast(`업데이트를 확인하지 못했습니다: ${status.error}`, 'error');
    manual = false;
  });

  setTimeout(() => { if (opts.enabled()) check(false); }, 10000);
  timer = setInterval(() => { if (opts.enabled()) check(false); }, CHECK_INTERVAL_MS);
}

function check(byUser) {
  if (!autoUpdater) {
    if (byUser) toast('설치된 앱에서만 업데이트를 확인할 수 있습니다 (지금은 개발 모드).', 'warn');
    return;
  }
  if (status.state === 'downloading' || status.state === 'ready') {
    if (byUser) toast(status.state === 'ready' ? '새 버전이 준비되어 있습니다. "업데이트" 버튼을 눌러 주세요.' : '새 버전을 내려받는 중입니다.');
    return;
  }
  manual = byUser;
  autoUpdater.checkForUpdates().catch(() => { /* error 이벤트에서 처리 */ });
}

/** 받아 둔 새 버전을 지금 설치하고 다시 시작 */
function installNow(beforeQuit) {
  if (!autoUpdater || status.state !== 'ready') return;
  beforeQuit(); // "닫으면 트레이로" 설정이어도 실제로 종료되도록
  autoUpdater.quitAndInstall(false, true);
}

function stop() {
  clearInterval(timer);
}

module.exports = { init, check, installNow, stop, status };
