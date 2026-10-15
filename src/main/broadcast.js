'use strict';
const { byId } = require('./services');
const { attachFiles, withDebugger } = require('./attach');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForLoad(wc, timeoutMs = 15000) {
  return new Promise((resolve) => {
    // 리스너를 먼저 걸고 상태를 확인해야 그 사이에 로딩이 끝나도 이벤트를 놓치지 않는다
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      resolve();
    }
    wc.once('did-stop-loading', done);
    if (wc.isDestroyed() || !wc.isLoading()) done();
  });
}

/** selector 목록에서 화면에 보이는 첫 입력창을 찾는 페이지 내 코드 조각 */
function findComposerSnippet(selectors) {
  return `const selectors = ${JSON.stringify(selectors)};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let el = null;
    for (const sel of selectors) { el = [...document.querySelectorAll(sel)].find(visible); if (el) break; }`;
}

/** 입력창을 포커스하고, selectAll이면 기존 내용을 선택(덮어쓰기용) — 아니면 커서만 끝으로 */
function focusComposerScript(selectors, selectAll = true) {
  return `(() => { ${findComposerSnippet(selectors)}
    if (!el) return false;
    el.focus();
    if (${selectAll}) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.select();
      else document.execCommand('selectAll');
    }
    return true;
  })()`;
}

/** 입력창에 남은 글자 수. 입력창을 찾지 못하면 -1 (재렌더링 중일 수 있으므로 성공으로 보지 않는다) */
function composerLengthScript(selectors) {
  return `(() => { ${findComposerSnippet(selectors)}
    if (!el) return -1;
    const v = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : el.innerText;
    return v.trim().length;
  })()`;
}

/**
 * Enter(또는 Shift+Enter)를 DevTools Protocol로 페이지에 직접 보낸다.
 * OS 키 입력(sendInputEvent)과 달리 창이 포커스가 없거나 최소화돼 있어도 전달된다.
 */
async function pressEnter(send, shift = false) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: shift ? 8 : 0 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/**
 * 한 서비스에 프롬프트를 입력하고 전송한다.
 * 입력은 모두 DevTools Protocol(send)로 해서, 전송 중 다른 창으로 넘어가거나 최소화해도 계속 진행된다.
 * @returns {Promise<'sent' | 'unconfirmed'>}
 */
async function sendTo(serviceId, wc, text, checkTarget, files, send) {
  const selectors = byId[serviceId].composer;
  await waitForLoad(wc);
  // 새 대화로 이동한 직후에는 입력창이 늦게 그려지므로 잠시 기다리며 찾는다
  let found = false;
  for (let waited = 0; !found && waited <= 10000; waited += 400) {
    if (waited) await delay(400);
    checkTarget();
    found = await wc.executeJavaScript(focusComposerScript(selectors), true);
  }
  if (!found) throw new Error('입력창을 찾지 못했습니다 (로그인 필요 또는 페이지 구조 변경)');

  if (files.length) {
    // 파일을 먼저 넣어 업로드를 시작시키고, 첨부 UI가 그려진 뒤 입력창에 다시 포커스
    checkTarget();
    await attachFiles(wc, files, selectors);
    await delay(800);
    checkTarget();
    if (!(await wc.executeJavaScript(focusComposerScript(selectors), true))) {
      throw new Error('파일 첨부 후 입력창을 찾지 못했습니다');
    }
  }

  // 전송 확인용: 질문 첫머리가 화면에 몇 번 보이는지(입력 전). 전송되면 대화에 내 질문이 새로 나타나 늘어난다.
  const probe = questionProbe(text);
  const shownBefore = probe ? await wc.executeJavaScript(countTextScript(probe), true) : 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    checkTarget();
    if (lines[i]) await send('Input.insertText', { text: lines[i] });
    if (i < lines.length - 1) await pressEnter(send, true);
  }
  await delay(250); // 에디터가 입력을 반영할 시간

  if ((await wc.executeJavaScript(composerLengthScript(selectors), true)) <= 0) {
    throw new Error('입력이 반영되지 않았습니다 (사이트 입력창 구조가 바뀌었을 수 있음)');
  }
  if (files.length) await waitUntilReady(wc, serviceId, selectors, checkTarget);

  // Enter는 한 번만 — 반복해서 누르면 같은 질문이 두 번 가거나 엉뚱한 버튼(업로드 취소 등)이 눌릴 수 있다
  checkTarget();
  if (!(await wc.executeJavaScript(focusComposerScript(selectors, false), true))) {
    throw new Error('보내기 직전에 입력창을 찾지 못했습니다');
  }
  await pressEnter(send);

  // 입력창이 비었고(전송됨) 대화에 내 질문이 새로 보이면 성공. 입력창만 비었으면 "확인 필요"로 남긴다
  // 같은 순간에 두 조건이 함께 맞아야 성공 — 입력창이 잠깐 비었다가 실패로 글이 되돌아온 경우를 걸러낸다
  const confirmMs = files.length ? 10000 : 4000;
  for (let waited = 0; waited < confirmMs; waited += 250) {
    await delay(250);
    if (wc.isDestroyed()) break;
    const empty = (await wc.executeJavaScript(composerLengthScript(selectors), true)) === 0;
    if (empty && (!probe || (await wc.executeJavaScript(countTextScript(probe), true)) > shownBefore)) return 'sent';
  }
  return 'unconfirmed';
}

/**
 * 화면에서 찾을 질문 첫머리. 마크다운으로 렌더링되면 사라지는 줄머리 기호(#, >, -, 1.)와 강조 기호(*, _, `)만 빼고
 * 일반 글자(state-of-the-art의 - 등)는 그대로 둔다. 너무 짧으면 확인하지 않는다.
 */
function questionProbe(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const plain = first
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length >= 4 ? plain.slice(0, 20) : '';
}

function countTextScript(probe) {
  return `(() => {
    const t = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
    return t.split(${JSON.stringify(probe)}).length - 1;
  })()`;
}

/**
 * 보내기 버튼이 켜져 있는지. 다른 "Send" 버튼과 헷갈리지 않도록 입력창 주변(조상 8단계까지)에서만 찾는다.
 * 버튼을 못 찾으면 null(판단 불가)
 */
function sendReadyScript(composerSelectors, buttonSelectors) {
  return `(() => { ${findComposerSnippet(composerSelectors)}
    if (!el) return null;
    for (let scope = el.parentElement, i = 0; scope && i < 8; scope = scope.parentElement, i++) {
      for (const sel of ${JSON.stringify(buttonSelectors)}) {
        const b = [...scope.querySelectorAll(sel)].find(visible);
        if (b) return !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      }
    }
    return null;
  })()`;
}

/**
 * 첨부 업로드가 끝나 보내기 버튼이 켜질 때까지 기다린다(최대 2분).
 * 버튼을 3초 동안 못 찾으면(사이트 구조 변경 등) 업로드 진행 표시가 1.5초 연속 없을 때 준비된 것으로 본다.
 */
async function waitUntilReady(wc, serviceId, composerSelectors, checkTarget) {
  const buttons = byId[serviceId].sendButton || [];
  let noButtonSince = null;
  let idleSince = null;
  for (let waited = 0; waited < 120000; waited += 500) {
    checkTarget();
    const ready = await wc.executeJavaScript(sendReadyScript(composerSelectors, buttons), true);
    if (ready === true) return;
    if (ready === false) {
      noButtonSince = null; // 버튼이 보이는데 꺼져 있음 = 업로드 중
      idleSince = null;
    } else {
      if (noButtonSince === null) { noButtonSince = waited; idleSince = null; }
      if (waited - noButtonSince >= 3000) {
        const busy = await wc.executeJavaScript(`document.querySelectorAll('[role="progressbar"], progress').length`, true);
        idleSince = busy ? null : (idleSince ?? waited);
        if (idleSince !== null && waited - idleSince >= 1500) return;
      }
    }
    await delay(500);
  }
  throw new Error('첨부 파일 업로드가 2분 안에 끝나지 않아 보내지 않았습니다');
}

/**
 * 대상 서비스들에 순차 전송한다(포커스를 하나씩 옮겨야 하므로 병렬 불가).
 * @param {string} text
 * @param {Array<{serviceId: string, webContents: Electron.WebContents}>} targets
 * @param {(target: {serviceId: string, webContents: Electron.WebContents}) => void} checkTarget
 *   대상이 여전히 유효한지(창 포커스, 뷰 부착 등) 확인하고 아니면 throw
 * @returns {Promise<Array<{serviceId: string, status: 'sent'|'unconfirmed'|'failed', error?: string}>>}
 */
async function broadcast(text, targets, checkTarget, files = []) {
  const results = [];
  for (const target of targets) {
    try {
      const status = await withDebugger(target.webContents, async (send) => {
        // 창이 포커스가 없거나 최소화돼 있어도 페이지가 "포커스된 상태"로 동작하게 한다
        await send('Emulation.setFocusEmulationEnabled', { enabled: true });
        try {
          return await sendTo(target.serviceId, target.webContents, text, () => checkTarget(target), files, send);
        } finally {
          await send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        }
      }).catch((err) => {
        // 개발자 도구가 열려 있으면 연결할 수 없다
        if (/attach|debugger/i.test(err.message)) throw new Error('이 탭에 개발자 도구가 열려 있어 보낼 수 없습니다');
        throw err;
      });
      results.push({ serviceId: target.serviceId, status });
    } catch (err) {
      results.push({ serviceId: target.serviceId, status: 'failed', error: err.message });
    }
  }
  return results;
}

module.exports = { broadcast };
