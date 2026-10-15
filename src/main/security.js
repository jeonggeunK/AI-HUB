'use strict';
const path = require('path');
const { app, shell } = require('electron');
const { isAllowedInTab, isServiceOrigin, isSignInUrl } = require('./services');

const CHROME_MAJOR = process.versions.chrome.split('.')[0];

// 실제 Chrome과 같은 "축약형" UA. Electron/앱 이름 토큰이 없어야 Google 로그인 차단을 피할 가능성이 높다.
const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const CHROME_FULL = process.versions.chrome;
const CH_UA_FULL = `"Google Chrome";v="${CHROME_FULL}", "Chromium";v="${CHROME_FULL}", "Not_A Brand";v="24.0.0.0"`;
const CH_UA = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`;

// 사용자 확인 없이 허용하는 권한. 카메라와 클립보드 읽기는 제외(붙여넣기는 paste 이벤트로 동작).
const ALLOWED_PERMISSIONS = new Set([
  'media', // 아래에서 마이크(audio)만 허용
  'clipboard-sanitized-write', // "복사" 버튼
  'notifications',
  'fullscreen',
]);

const configured = new WeakSet();
const popups = new Set(); // 로그인 팝업 등 서비스가 연 창 — 메인 창 종료 시 함께 닫는다

function isGoogleHost(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname;
    return h === 'google.com' || h.endsWith('.google.com');
  } catch { return false; }
}

/** partition(=계정) 세션마다 한 번만 설정 */
function setupSession(ses, serviceId) {
  if (configured.has(ses)) return;
  configured.add(ses);

  ses.setUserAgent(CHROME_UA);

  // Google 로그인의 "안전하지 않은 브라우저" 판정을 피하기 위해 Google 도메인 요청에만 브랜드 힌트를 보정
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.google.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders;
    if (isGoogleHost(details.url)) {
      for (const key of Object.keys(headers)) {
        const k = key.toLowerCase();
        if (k === 'sec-ch-ua') headers[key] = CH_UA;
        else if (k === 'sec-ch-ua-full-version-list') headers[key] = CH_UA_FULL;
      }
    }
    callback({ requestHeaders: headers });
  });

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = details.requestingUrl || details.securityOrigin || '';
    if (!ALLOWED_PERMISSIONS.has(permission) || !isServiceOrigin(serviceId, origin)) return callback(false);
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      return callback(types.length > 0 && types.every((t) => t === 'audio'));
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (!ALLOWED_PERMISSIONS.has(permission) || !isServiceOrigin(serviceId, requestingOrigin)) return false;
    if (permission === 'media') return details && details.mediaType === 'audio';
    return true;
  });

  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
}

// 페이지가 스크립트로 외부 링크를 연달아 여는 것을 막기 위한 탭별 속도 제한
const EXTERNAL_COOLDOWN_MS = 1000;
const lastExternalAt = new WeakMap(); // webContents -> 마지막 외부 열기 시각

function openExternalSafe(url, wc) {
  let protocol;
  try { protocol = new URL(url).protocol; } catch { return; }
  if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'mailto:') return;
  const now = Date.now();
  if (wc) {
    if (now - (lastExternalAt.get(wc) || 0) < EXTERNAL_COOLDOWN_MS) return;
    lastExternalAt.set(wc, now);
  }
  shell.openExternal(url).catch(() => {});
}

/**
 * 서비스 탭(및 그 팝업)의 webContents에 이동/팝업 규칙을 건다.
 * - 서비스/인증 도메인: 탭 안 또는 같은 세션의 팝업 창에서 처리
 * - 그 외: 기본 브라우저로 넘김
 * - 로그인 화면: onSignIn이 true를 돌려주면(= Chrome 로그인으로 넘김) 탭 안 이동을 막는다
 *
 * @param {(url: string) => boolean} [onSignIn]
 * @param {Electron.BrowserWindow} [popupWindow] 로그인 팝업 자신 — 가로채면 팝업을 닫는다
 */
function attachGuards(wc, serviceId, onSignIn, popupWindow) {
  const interceptSignIn = (url) => {
    if (!onSignIn || !isSignInUrl(serviceId, url) || !onSignIn(url)) return false;
    if (popupWindow) setImmediate(() => !popupWindow.isDestroyed() && popupWindow.close());
    return true;
  };

  wc.setWindowOpenHandler(({ url }) => {
    if (interceptSignIn(url)) return { action: 'deny' };
    if (url === 'about:blank' || url === '' || isAllowedInTab(serviceId, url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    openExternalSafe(url, wc);
    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => {
    // 팝업은 opener의 세션을 물려받는다. 로그인 쿠키가 같은 계정에 저장되는지 확인.
    if (child.webContents.session !== wc.session) {
      console.warn(`[security] ${serviceId} 팝업이 다른 세션을 사용합니다 — 로그인이 유지되지 않을 수 있음`);
    }
    popups.add(child);
    child.once('closed', () => popups.delete(child));
    attachGuards(child.webContents, serviceId, onSignIn, child);
  });

  wc.on('will-navigate', (event) => {
    if (interceptSignIn(event.url)) {
      event.preventDefault();
    } else if (!isAllowedInTab(serviceId, event.url)) {
      event.preventDefault();
      openExternalSafe(event.url, wc);
    }
  });

  // 서버 리디렉트로 로그인 화면에 가는 경우(예: chatgpt.com → auth.openai.com)
  wc.on('will-redirect', (event) => {
    if (event.isMainFrame && interceptSignIn(event.url)) event.preventDefault();
  });
}

/** 앱 종료 시 호출 — beforeunload로 취소되지 않도록 destroy */
function closeAllPopups() {
  for (const w of [...popups]) if (!w.isDestroyed()) w.destroy();
  popups.clear();
}

module.exports = { CHROME_UA, setupSession, attachGuards, openExternalSafe, closeAllPopups };
