'use strict';

// 로그인 과정에서 탭 안에 머물러도 되는 공용 인증 도메인
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'challenges.cloudflare.com',
];

/**
 * 서비스 정의. 브로드캐스트용 selector는 사이트 개편 시 여기만 고치면 된다.
 * - hosts: 탭 안에서 이동을 허용할 도메인(하위 도메인 포함)
 * - appHosts: 마이크/알림 등 권한을 줄 정확한 호스트(하위 도메인 미포함)
 * - composer: 프롬프트 입력창 후보 selector (앞에서부터 시도)
 * - sendButton: 보내기 버튼 후보 — 첨부 업로드가 끝났는지(버튼이 켜졌는지) 판단할 때 사용
 * - sessionCookie: 로그인 완료를 판단하는 쿠키 이름(접두어) — "브라우저로 로그인"에서 사용
 * - loginUrls: 이 서비스 자체의 로그인 화면 — "로그인은 Chrome에서" 설정일 때 가로채서 Chrome으로 보낸다
 * - nativeApp: "원본 앱으로 열기" — Windows 시작 메뉴 AppID (shell:AppsFolder)
 */
const SERVICES = [
  {
    id: 'claude',
    name: 'Claude',
    color: '#d97757',
    url: 'https://claude.ai/new',
    hosts: ['claude.ai', 'anthropic.com', 'claudeusercontent.com'],
    appHosts: ['claude.ai'],
    sessionCookie: 'sessionKey',
    loginUrls: [],
    composer: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    sendButton: ['button[aria-label="Send message"]', 'button[aria-label="메시지 보내기"]', 'button[aria-label*="Send"]', 'button[aria-label*="보내기"]'],
    nativeApp: { type: 'appx', appId: 'Claude_pzs8sxrjxfjjc!Claude' },
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    color: '#10a37f',
    url: 'https://chatgpt.com/',
    hosts: ['chatgpt.com', 'openai.com', 'oaiusercontent.com'],
    appHosts: ['chatgpt.com'],
    sessionCookie: '__Secure-next-auth.session-token',
    loginUrls: [/^https:\/\/auth\.openai\.com\//, /^https:\/\/chatgpt\.com\/auth\/login/],
    composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea'],
    sendButton: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label*="Send"]', 'button[aria-label*="보내기"]'],
    nativeApp: { type: 'appx', appId: 'OpenAI.Codex_2p2nqsd0c76g0!App' },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    color: '#4285f4',
    url: 'https://gemini.google.com/app',
    hosts: ['gemini.google.com', 'google.com', 'gstatic.com', 'googleusercontent.com'],
    appHosts: ['gemini.google.com'],
    sessionCookie: '__Secure-1PSID',
    loginUrls: [],
    composer: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    sendButton: ['button.send-button', 'button[aria-label*="보내기"]', 'button[aria-label*="Send"]'],
    nativeApp: { type: 'appx', appId: 'com.google.gemini.windows' },
  },
];

const byId = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/** 탭 내부 이동을 허용할지: 서비스 자체 도메인 또는 인증 도메인이면 허용 */
function isAllowedInTab(serviceId, rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol === 'about:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'https:') return false;
  const svc = byId[serviceId];
  return svc.hosts.some((d) => hostMatches(u.hostname, d)) || AUTH_HOSTS.some((d) => hostMatches(u.hostname, d));
}

// 외부 로그인 제공자 — 앱 내장 브라우저에서는 패스키·보안 확인이 막히기 쉽다
const SIGN_IN_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com', 'login.microsoftonline.com', 'login.live.com'];

/** 로그인 화면으로 가는 주소인지 (외부 로그인 제공자 또는 서비스 자체 로그인 화면) */
function isSignInUrl(serviceId, rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (/log-?out|sign-?out/i.test(u.pathname)) return false; // 로그아웃은 앱 안에서 그대로
  if (SIGN_IN_HOSTS.some((d) => hostMatches(u.hostname, d))) {
    // Gemini는 google.com 안에서 동작하므로, 계정 선택 등 로그인 화면일 때만
    return u.hostname !== 'accounts.google.com' || /\/(signin|ServiceLogin|v3\/signin|AccountChooser)/i.test(u.pathname);
  }
  return byId[serviceId].loginUrls.some((re) => re.test(rawUrl));
}

/** 권한 요청(마이크, 알림 등)을 허용할 출처인지: 서비스 앱의 정확한 호스트만 */
function isServiceOrigin(serviceId, rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  return u.protocol === 'https:' && byId[serviceId].appHosts.includes(u.hostname);
}

module.exports = { SERVICES, byId, hostMatches, isAllowedInTab, isServiceOrigin, isSignInUrl };
