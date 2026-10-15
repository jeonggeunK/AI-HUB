'use strict';
/**
 * 동시 질문 첨부: 각 서비스 탭의 채팅 입력에 파일(이미지 포함)을 넣는다.
 *
 * 1순위 — 입력창 가까이에 있는 파일 선택 칸(input[type=file])을 찾아 DevTools Protocol의
 *         DOM.setFileInputFiles로 넣는다. 사람이 "파일 선택"으로 고른 것과 같아서 사이트의 업로드 처리가 그대로 동작한다.
 * 2순위 — 맞는 칸이 없으면 입력창 위에 진짜 OS 드래그 앤 드롭(Input.dispatchDragEvent)을 일으킨다.
 * 그다음 — 첨부 표시(파일 이름·이미지 미리보기)가 실제로 나타났는지 확인한다. 확인되지 않으면 실패로 처리해서
 *          첨부 없이 글만 보내지는 일을 막는다.
 */
const fs = require('fs');
const path = require('path');

const MAX_FILES = 10;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const VERIFY_TIMEOUT_MS = 20000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.xml': 'application/xml', '.js': 'text/javascript', '.py': 'text/x-python',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.hwp': 'application/x-hwp', '.zip': 'application/zip',
};

const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
const isImage = (file) => mimeOf(file).startsWith('image/');

/** 실제로 있는 일반 파일만, 개수·크기 제한 */
function validateFiles(paths) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const p of paths.slice(0, MAX_FILES)) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size <= MAX_FILE_BYTES) out.push(path.resolve(p));
    } catch { /* 없는 파일은 건너뜀 */ }
  }
  return out;
}

/** 페이지 안에서 입력창을 찾는 코드 조각 (el 변수에 담김) */
function composerSnippet(selectors) {
  return `const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let el = null;
    for (const sel of ${JSON.stringify(selectors)}) { el = [...document.querySelectorAll(sel)].find(visible); if (el) break; }`;
}

/**
 * 입력창과 가장 가까운(공통 조상이 깊은) 파일 칸 중 이 파일들을 받는 것을 고른다. shadow DOM 안쪽도 찾는다.
 * 반환값은 요소 자체 — CDP가 objectId로 받아 setFileInputFiles에 쓴다.
 */
function pickInputExpression(selectors, files) {
  const want = files.map((f) => ({ ext: path.extname(f).toLowerCase(), mime: mimeOf(f) }));
  return `(() => { ${composerSnippet(selectors)}
    const want = ${JSON.stringify(want)};
    const inputs = [];
    const walk = (root) => {
      for (const n of root.querySelectorAll('*')) {
        if (n.tagName === 'INPUT' && n.type === 'file') inputs.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
      }
    };
    walk(document);
    const accepts = (input) => {
      const a = (input.accept || '').toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
      if (!a.length || a.includes('*') || a.includes('*/*')) return true;
      return want.every((w) => a.some((t) => t === w.ext || t === w.mime || (t.endsWith('/*') && w.mime.startsWith(t.slice(0, -1)))));
    };
    const ancestors = (n) => { const list = []; for (let p = n; p; p = p.parentNode || p.host) list.push(p); return list; };
    const composerChain = el ? ancestors(el) : [];
    const closeness = (n) => { const chain = new Set(ancestors(n)); const i = composerChain.findIndex((a) => chain.has(a)); return i === -1 ? -1000 : -i; };
    let best = null, bestScore = -Infinity;
    for (const input of inputs) {
      if (input.disabled || !accepts(input)) continue;
      if (want.length > 1 && !input.multiple) continue;
      // 가까울수록, 그리고 받는 형식이 좁을수록(이미지 전용 등) 그 용도의 칸일 가능성이 크다
      const score = closeness(input) * 10 + (input.accept ? 1 : 0) + (input.multiple ? 1 : 0);
      if (score > bestScore) { best = input; bestScore = score; }
    }
    return best;
  })()`;
}

/** 첨부 확인용 현재 상태: 페이지 글자(파일 이름 확인)와 미리보기 이미지 수 */
const snapshotExpression = `(() => ({
  text: document.body ? document.body.innerText : '',
  previews: document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length,
}))()`;

async function withDebugger(wc, fn) {
  const dbg = wc.debugger;
  let attachedHere = false;
  if (!dbg.isAttached()) {
    dbg.attach('1.3'); // DevTools가 열려 있으면 실패 — 호출한 쪽에서 오류로 처리
    attachedHere = true;
  }
  try {
    return await fn((method, params) => dbg.sendCommand(method, params));
  } finally {
    if (attachedHere) {
      try { dbg.detach(); } catch { /* 이미 끊김 */ }
    }
  }
}

async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: false });
  if (exceptionDetails) throw new Error(exceptionDetails.text || '페이지 스크립트 오류');
  return result;
}

/**
 * 서비스 탭에 파일을 첨부하고, 첨부 표시가 나타날 때까지 확인한다.
 * @returns {Promise<'input'|'drag'>} 사용한 방법
 */
async function attachFiles(wc, files, composerSelectors) {
  const before = await wc.executeJavaScript(snapshotExpression, true);

  const method = await withDebugger(wc, async (send) => {
    // 1순위: 파일 칸
    const picked = await evaluate(send, pickInputExpression(composerSelectors, files));
    if (picked.objectId) {
      await send('DOM.setFileInputFiles', { objectId: picked.objectId, files });
      return 'input';
    }
    // 2순위: 입력창 위에 진짜 드래그 앤 드롭
    const rect = (await evaluate(send, `(() => { ${composerSnippet(composerSelectors)}
      if (!el) return null; const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`)).value;
    if (!rect) throw new Error('파일을 놓을 입력창을 찾지 못했습니다');
    const { x, y } = JSON.parse(rect);
    const data = { items: [], files, dragOperationsMask: 1 };
    await send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
    await delay(150);
    await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
    await delay(150); // 사이트가 "여기에 놓기" 영역을 띄울 시간
    await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
    await send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    return 'drag';
  });

  // 첨부가 실제로 화면에 나타났는지 확인 — 이미지는 미리보기 수, 그 외 파일은 파일 이름
  // 파일마다 "이름이 새로 보임" 또는 (이미지면) "미리보기가 새로 생김" 중 하나면 첨부된 것으로 본다.
  // 이름은 칩에서 말줄임될 수 있어 앞 12글자로, 이전 대화에 같은 이름이 있을 수 있어 "늘어난 횟수"로 센다.
  const count = (text, s) => text.split(s).length - 1;
  // 이름 앞부분 -> 그 앞부분을 가진 파일 수 (앞부분이 같은 파일이 여러 개일 수 있음). 이미지와 그 외를 따로 센다.
  const prefixes = (list) => {
    const m = new Map();
    for (const f of list) {
      const key = path.basename(f, path.extname(f)).slice(0, 12);
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  };
  const imageFiles = files.filter(isImage);
  const needOther = prefixes(files.filter((f) => !isImage(f)));
  const needImage = prefixes(imageFiles);
  const credit = (need, now) => {
    let c = 0;
    for (const [key, n] of need) c += Math.min(n, Math.max(0, count(now.text, key) - count(before.text, key)));
    return c;
  };
  for (let waited = 0; waited < VERIFY_TIMEOUT_MS; waited += 500) {
    await delay(500);
    if (wc.isDestroyed()) throw new Error('탭이 닫혔습니다');
    const now = await wc.executeJavaScript(snapshotExpression, true);
    // 이미지 한 장이 이름과 미리보기를 둘 다 보여도 한 번만 인정 — 이미지는 둘 중 큰 쪽만 센다
    const imageCredit = Math.min(imageFiles.length, Math.max(credit(needImage, now), now.previews - before.previews));
    if (credit(needOther, now) + Math.max(0, imageCredit) >= files.length) return method;
  }
  throw new Error('첨부가 확인되지 않아 보내지 않았습니다 (이 사이트가 그 파일 형식을 받지 않을 수 있음)');
}

module.exports = { attachFiles, validateFiles, withDebugger, MAX_FILES, MAX_FILE_BYTES };
