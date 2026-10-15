'use strict';
/**
 * "브라우저로 로그인": 앱 내장 브라우저에서 막히는 로그인(Google 패스키/보안 확인 등)을
 * 실제 Chrome/Edge에서 진행한 뒤, 그 서비스의 로그인 쿠키를 앱의 계정 저장소로 옮긴다.
 *
 * 1단계(로그인): 일회용 프로필로 브라우저를 "아무 연결 없이" 띄운다.
 *   디버깅 연결이 붙어 있으면 Cloudflare가 자동화 브라우저로 보고 사람 확인을 무한 반복하므로,
 *   로그인하는 동안은 평범한 브라우저 그대로 둔다. 사용자가 로그인 후 창을 닫으면 끝.
 * 2단계(가져오기): 같은 프로필을 화면 없이(headless) 다시 열어 파이프(CDP)로 쿠키만 읽는다.
 *   쿠키 파일은 브라우저 자신만 복호화할 수 있어서(앱 바운드 암호화) 이 방법이 필요하다.
 *   웹페이지를 열지 않으므로 봇 검사도 없다. 네트워크 포트도 열지 않는다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { byId, hostMatches } = require('./services');

const LOGIN_TIMEOUT_MS = 20 * 60 * 1000;
const READ_TIMEOUT_MS = 30 * 1000;

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';

// Chrome을 우선 사용 — 휴대폰 패스키·Google 계정 연동이 가장 잘 된다
const BROWSERS = [
  { name: 'Chrome', paths: [path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'), path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'), path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe')] },
  { name: 'Edge', paths: [path.join(PF86, 'Microsoft\\Edge\\Application\\msedge.exe'), path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe')] },
];

function findBrowser() {
  for (const b of BROWSERS) {
    const exe = b.paths.find((p) => p && fs.existsSync(p));
    if (exe) return { name: b.name, exe };
  }
  return null;
}

// ───────────── 쿠키 ─────────────

/** Cloudflare 봇 확인 쿠키는 브라우저 UA에 묶여 있어 옮겨도 무효 — 제외 */
const SKIP_COOKIE = /^(cf_|__cf|_cfuvid)/;

function cookieBelongsTo(serviceId, cookie) {
  const host = cookie.domain.replace(/^\./, '');
  return byId[serviceId].hosts.some((d) => hostMatches(host, d));
}

/** 이 서비스의 로그인 쿠키들 (ChatGPT처럼 .0, .1 조각으로 나뉜 것 포함) */
function sessionCookies(serviceId, cookies) {
  const prefix = byId[serviceId].sessionCookie;
  return cookies.filter((c) => c.value && (c.name === prefix || c.name.startsWith(prefix + '.')) && cookieBelongsTo(serviceId, c));
}

/** 로그인 쿠키가 있는지. 여러 조각으로 나뉜 쿠키는 0번부터 이어져야 한다 */
function hasSession(serviceId, cookies) {
  const prefix = byId[serviceId].sessionCookie;
  const found = sessionCookies(serviceId, cookies)
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (found.length === 0) return false;
  const chunks = found.filter((n) => n !== prefix);
  return chunks.length === 0 || chunks.every((n, i) => n === `${prefix}.${i}`);
}

/** CDP 쿠키 → Electron cookies.set 형식 */
function toElectronCookie(c) {
  const hostOnly = !c.domain.startsWith('.');
  const out = {
    url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (!hostOnly) out.domain = c.domain; // __Host- 쿠키 등 host-only 쿠키에는 domain을 넣으면 안 된다
  if (!c.session && c.expires > 0) out.expirationDate = c.expires;
  const sameSite = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[c.sameSite];
  if (sameSite) out.sameSite = sameSite;
  return out;
}

// ───────────── 프로세스 ─────────────

/** 프로세스가 끝나면 resolve. 취소되면 즉시 종료시키고, 시간이 지나면 종료시키고 reject */
function waitForExit(child, signal, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    const finish = (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (err) reject(err); else resolve();
    };
    const onExit = () => finish(timedOut ? new Error(timeoutMessage) : signal.aborted ? signal.reason : null);
    const onError = (err) => finish(new Error(`브라우저를 실행하지 못했습니다: ${err.message}`));
    // 강제 종료 후에도 종료 신호가 오지 않으면 5초 뒤 포기 — 기다림이 끝없이 이어지지 않게
    const killAndWait = () => {
      if (child.exitCode === null) child.kill();
      killTimer = setTimeout(() => finish(timedOut ? new Error(timeoutMessage) : signal.reason), 5000);
    };
    const onAbort = () => killAndWait();
    child.on('exit', onExit);
    child.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    timer = setTimeout(() => { timedOut = true; killAndWait(); }, timeoutMs);
  });
}

/** 취소되면 즉시 끝나는 대기 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** --remote-debugging-pipe: fd 3으로 보내고 fd 4로 받는다. 메시지는 NUL 문자로 구분된 JSON */
function pipeCdp(child) {
  const out = child.stdio[3];
  const inp = child.stdio[4];
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let closed = null;

  inp.setEncoding('utf8');
  inp.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\0')) !== -1) {
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const p = msg.id && pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  inp.on('close', () => {
    closed = new Error('브라우저 연결이 끊겼습니다');
    for (const p of pending.values()) p.reject(closed);
    pending.clear();
  });
  out.on('error', () => { /* 종료 시 쓰기 실패는 close 쪽에서 처리 */ });

  return {
    send(method, params = {}) {
      if (closed) return Promise.reject(closed);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        out.write(JSON.stringify({ id, method, params }) + '\0');
      });
    },
  };
}

/** 2단계: 같은 프로필을 화면 없이 열어 쿠키를 읽는다 */
async function readCookies(exe, profileDir, signal) {
  const child = spawn(exe, [
    '--headless=new',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const exited = waitForExit(child, signal, READ_TIMEOUT_MS, '로그인 정보를 읽는 데 시간이 너무 오래 걸립니다');
  exited.catch(() => {}); // 아래에서 따로 기다린다
  try {
    const cdp = pipeCdp(child);
    const { cookies } = await Promise.race([cdp.send('Storage.getCookies'), exited.then(() => { throw new Error('브라우저가 예기치 않게 종료되었습니다'); })]);
    await cdp.send('Browser.close').catch(() => {});
    return cookies;
  } finally {
    if (child.exitCode === null) child.kill();
    await exited.catch(() => {});
  }
}

/**
 * @param {object} opts
 * @param {string} opts.serviceId
 * @param {Electron.Session} opts.session 쿠키를 넣을 계정 세션
 * @param {string} opts.profileRoot 일회용 브라우저 프로필을 만들 상위 폴더
 * @param {AbortSignal} opts.signal 취소 — 브라우저를 즉시 종료하고 쿠키를 넣지 않는다
 * @param {() => void} [opts.onLoginWindowClosed] 1단계가 끝나 가져오기를 시작할 때
 * @returns {Promise<{browser: string, imported: number}>}
 */
async function loginWithBrowser({ serviceId, session, profileRoot, signal, onLoginWindowClosed }) {
  const browser = findBrowser();
  if (!browser) throw new Error('Chrome 또는 Edge를 찾지 못했습니다');
  const svc = byId[serviceId];
  const profileDir = path.join(profileRoot, crypto.randomUUID());
  fs.mkdirSync(profileDir, { recursive: true });

  try {
    // 1단계: 평범한 브라우저로 로그인 — 사용자가 창을 닫을 때까지 기다린다
    const login = spawn(browser.exe, [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode', // 창을 닫으면 프로세스도 끝나야 다음 단계로 넘어간다
      '--new-window',
      svc.url,
    ], { stdio: 'ignore' });
    await waitForExit(login, signal, LOGIN_TIMEOUT_MS, '20분 안에 로그인이 끝나지 않아 브라우저를 닫았습니다');
    if (onLoginWindowClosed) onLoginWindowClosed();

    // 2단계: 쿠키 읽기 — 방금 닫힌 브라우저가 프로필 잠금을 늦게 풀면 바로 실패할 수 있어 몇 번 재시도
    let cookies = null;
    for (let attempt = 1; !cookies; attempt++) {
      try {
        cookies = await readCookies(browser.exe, profileDir, signal);
      } catch (err) {
        if (signal.aborted || attempt >= 3) throw err;
        await sleep(1000 * attempt, signal);
      }
    }
    if (!hasSession(serviceId, cookies)) {
      throw new Error(`${browser.name}에서 ${svc.name} 로그인 정보를 찾지 못했습니다. 로그인을 마친 뒤 창을 닫았는지 확인하세요`);
    }

    // 예전 로그인의 쿠키 조각이 남아 새 것과 섞이지 않도록 앱 쪽 로그인 쿠키를 먼저 지운다.
    // 가져오기가 실패하면 원래 로그인으로 되돌린다(잘 쓰던 계정이 로그아웃되지 않도록).
    const previous = sessionCookies(serviceId, await session.cookies.get({}));
    const cookieUrl = (c) => `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
    for (const c of previous) await session.cookies.remove(cookieUrl(c), c.name).catch(() => {});
    try {
      return await importCookies(cookies);
    } catch (err) {
      for (const c of sessionCookies(serviceId, await session.cookies.get({}))) {
        await session.cookies.remove(cookieUrl(c), c.name).catch(() => {});
      }
      for (const c of previous) {
        const restore = { url: cookieUrl(c), name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
        if (!c.hostOnly) restore.domain = c.domain;
        if (c.expirationDate) restore.expirationDate = c.expirationDate;
        await session.cookies.set(restore).catch(() => {});
      }
      throw err;
    }
  } finally {
    await removeDir(profileDir);
  }

  async function importCookies(cookies) {
    let imported = 0;
    for (const c of cookies) {
      if (signal.aborted) throw signal.reason; // 로그아웃·삭제와 겹치면 중간에라도 멈춘다
      if (!cookieBelongsTo(serviceId, c) || SKIP_COOKIE.test(c.name) || c.partitionKey) continue;
      try {
        await session.cookies.set(toElectronCookie(c));
        imported++;
      } catch (err) {
        console.warn(`[browserLogin] 쿠키 ${c.name} 복사 실패: ${err.message}`);
      }
    }
    if (signal.aborted) throw signal.reason;
    await session.cookies.flushStore();
    // 브라우저에서 읽은 로그인 쿠키와 앱에 들어간 값이 정확히 같은지 확인
    const print = (list) => sessionCookies(serviceId, list).map((c) => `${c.name}=${c.value}`).sort().join(';');
    if (!hasSession(serviceId, await session.cookies.get({})) || print(await session.cookies.get({})) !== print(cookies)) {
      throw new Error('로그인 쿠키를 앱으로 옮기지 못했습니다. 다시 시도해 주세요');
    }
    return { browser: browser.name, imported };
  }
}

/** 브라우저가 파일을 막 놓은 직후엔 삭제가 실패할 수 있어 몇 번 재시도 */
async function removeDir(dir) {
  for (let i = 0; i < 6; i++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.warn(`[browserLogin] 임시 프로필 삭제 실패: ${dir}`);
  return false;
}

module.exports = { loginWithBrowser, findBrowser, hasSession };
