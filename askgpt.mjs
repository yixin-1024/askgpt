#!/usr/bin/env node
// askgpt.mjs — drive the (Codex-kernel) ChatGPT desktop app's embedded chatgpt.com
// via CDP, using your CHAT quota (regular models), bypassing the Codex #pricing gate.
//
// How it works:
//   The app (bundle com.openai.codex) renders chat as a chatgpt.com <webview> that is
//   forced to ?source=codex#pricing (Codex paywall) once Codex credits run out.
//   We DON'T touch that webview. Instead we open a fresh top-level chatgpt.com page in
//   the same Electron browser, copy the webview's auth cookies into it, and drive that
//   clean page — it lands on normal chatgpt.com (no source=codex) = your chat quota.
//
// Requires the app running with:  --remote-debugging-port=9238 --remote-allow-origins=*
// (the `askgpt` bash wrapper handles launching it).
//
// Output is the assistant's raw GFM MARKDOWN, reassembled from the conversation WebSocket delta
// stream (the app still runs — it maintains the session and passes Cloudflare/Sentinel for us —
// but we read the network stream, not the DOM). Set ASKGPT_PLAIN=1 for rendered plain text.
//
// Usage:
//   node askgpt.mjs "your question" [timeoutSec]   # ask (default cmd)
//   node askgpt.mjs ask "..." [timeoutSec]
//   node askgpt.mjs new                            # start a fresh conversation
//   node askgpt.mjs setup                          # (re)create the clean logged-in page
//   node askgpt.mjs status
// Env: ASKGPT_MODEL, ASKGPT_LEVEL (reasoning tier), ASKGPT_PLAIN=1 (plain text instead of markdown)

const PORT = process.env.ASKGPT_PORT || 9238;
const BASE = `http://127.0.0.1:${PORT}`;

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`);
  return await r.json();
}
async function browserWs() {
  const r = await fetch(`${BASE}/json/version`);
  return (await r.json()).webSocketDebuggerUrl;
}
function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pend = new Map(); const handlers = [];
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    else if (m.method) { for (const h of handlers) h(m.method, m.params); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pend.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ready, send, on: (h) => handlers.push(h), close: () => ws.close() };
}
async function evalOn(c, expression) {
  const x = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (x.exceptionDetails) throw new Error('EVAL ' + JSON.stringify(x.exceptionDetails.exception?.description || x.exceptionDetails));
  return x.result?.value;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CHECK_LOGIN = `(()=>({loggedIn:!!document.querySelector('[data-testid="accounts-profile-button"]'),composer:!!document.querySelector('#prompt-textarea,div[contenteditable="true"]'),href:location.href,pricing:!!document.querySelector('[data-testid*="pricing-modal"],[data-testid*="select-plan"]')}))()`;

async function findWebview() {
  const ts = await listTargets();
  return ts.find(t => t.type === 'webview' && (t.url || '').includes('chatgpt.com'));
}
async function findCleanLoggedInPage() {
  const ts = await listTargets();
  const cands = ts.filter(t => t.type === 'page' && (t.url || '').includes('chatgpt.com'));
  for (const t of cands) {
    try {
      const c = client(t.webSocketDebuggerUrl); await c.ready; await c.send('Runtime.enable');
      const st = await evalOn(c, CHECK_LOGIN); c.close();
      if (st.loggedIn && !st.pricing && !/source=codex/.test(st.href)) return t;
    } catch {}
  }
  return null;
}

async function copyCookiesFromWebviewTo(pageTarget) {
  const wvT = await findWebview();
  if (!wvT) throw new Error('未找到已登录的 webview（请先在 ChatGPT app 里登录）');
  const wv = client(wvT.webSocketDebuggerUrl); await wv.ready; await wv.send('Network.enable');
  const { cookies } = await wv.send('Network.getAllCookies');
  wv.close();
  const auth = cookies.filter(c => /chatgpt\.com|openai\.com|auth0|challenges\.cloudflare/i.test(c.domain));
  const toSet = auth.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expires > 0 ? c.expires : undefined }));
  const pg = client(pageTarget.webSocketDebuggerUrl); await pg.ready;
  await pg.send('Network.enable'); await pg.send('Page.enable');
  await pg.send('Network.setCookies', { cookies: toSet });
  await pg.send('Page.navigate', { url: 'https://chatgpt.com/' });
  await sleep(6000);
  const st = await evalOn(pg, CHECK_LOGIN); pg.close();
  return st;
}

async function createCleanPage() {
  const b = client(await browserWs()); await b.ready;
  const { targetId } = await b.send('Target.createTarget', { url: 'https://chatgpt.com/' });
  b.close();
  // wait for it to appear with a ws url
  for (let i = 0; i < 30; i++) {
    const ts = await listTargets();
    const t = ts.find(x => x.id === targetId && x.webSocketDebuggerUrl);
    if (t) return t;
    await sleep(400);
  }
  throw new Error('新建 chatgpt 页面 target 超时');
}

async function ensureCleanPage() {
  let t = await findCleanLoggedInPage();
  if (t) return t;
  t = await createCleanPage();
  const st = await copyCookiesFromWebviewTo(t);
  if (!st.loggedIn) throw new Error('cookie 复制后仍未登录：' + JSON.stringify(st));
  // re-fetch the target (url changed)
  const ts = await listTargets();
  return ts.find(x => x.id === t.id) || t;
}

// ---- composer model/level picker helpers ----
async function clickXY(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(70);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function pressEsc(c) { for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); }
const SW_LABEL = `(()=>{const ta=document.querySelector('#prompt-textarea');const f=ta&&ta.closest('form')||document;const b=[...f.querySelectorAll('button[aria-haspopup=menu]')][0];return b?(b.textContent||'').replace(/\\s+/g,' ').trim():'';})()`;
const SW_CENTER = `(()=>{const ta=document.querySelector('#prompt-textarea');const f=ta&&ta.closest('form')||document;const b=[...f.querySelectorAll('button[aria-haspopup=menu]')][0];if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
const menuOpen = c => evalOn(c, `!!document.querySelector('[data-testid=composer-intelligence-picker-content]')`);
const cByRT = (role, text) => `(()=>{const els=[...document.querySelectorAll('[role=${role}]')].filter(m=>(m.textContent||'').replace(/\\s+/g,' ').trim()===${JSON.stringify(text)}&&m.getBoundingClientRect().width>0);const e=els[els.length-1];if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
async function openMenu(c) { for (let i = 0; i < 4 && !(await menuOpen(c)); i++) { const s = await evalOn(c, SW_CENTER); if (s) await clickXY(c, s.x, s.y); await sleep(600); } return menuOpen(c); }

// ensure model family = `model` (submenu) and reasoning level = `level` (radio). Idempotent by label.
async function ensureModel(c, model, level) {
  if ((await evalOn(c, SW_LABEL)) === level) return level; // level already set (model family persists per account)
  await pressEsc(c); await sleep(250);
  await openMenu(c);
  const parent = await evalOn(c, cByRT('menuitem', model));
  if (parent) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: parent.x, y: parent.y }); await sleep(800);
    const mo = await evalOn(c, cByRT('menuitemradio', model));
    if (mo) { await clickXY(c, mo.x, mo.y); await sleep(600); }
  }
  await pressEsc(c); await sleep(250);
  await openMenu(c);
  const lv = await evalOn(c, cByRT('menuitemradio', level));
  if (lv) { await clickXY(c, lv.x, lv.y); await sleep(600); }
  await pressEsc(c); await sleep(350);
  return await evalOn(c, SW_LABEL);
}

async function pressKey(c, key, code, vk, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
// Enter submit MUST use rawKeyDown: a plain keyDown for Enter carries a char and the Lexical
// editor swallows it as a newline / no-op; rawKeyDown fires the submit shortcut cleanly.
async function submitEnter(c) {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
async function clearComposer(c) {
  await evalOn(c, `(()=>{const el=document.querySelector('#prompt-textarea');el&&el.focus();})()`); await sleep(120);
  await pressKey(c, 'a', 'KeyA', 65, 4); // Cmd+A (Meta) select all
  await sleep(100);
  await pressKey(c, 'Delete', 'Delete', 46); await sleep(150);
  return await evalOn(c, `(document.querySelector('#prompt-textarea')?.innerText||'').trim().length`);
}
const userCount = c => evalOn(c, `document.querySelectorAll('[data-message-author-role=user]').length`);
// submit the prompt via ENTER (a synthesized send-button click does NOT trigger Lexical's submit).
async function submitPrompt(c, prompt) {
  await clearComposer(c);
  await evalOn(c, `(()=>{const el=document.querySelector('#prompt-textarea');el&&el.focus();})()`); await sleep(120);
  await c.send('Input.insertText', { text: prompt }); await sleep(400);
  const typed = await evalOn(c, `(document.querySelector('#prompt-textarea')?.innerText||'').trim().length`);
  if (!typed) throw new Error('无法把问题填进输入框');
  const before = await userCount(c);
  // On a fresh page neither a synthesized Enter nor a coordinate mouse-click reliably submits;
  // invoking the send button's own .click() handler via JS does. Retry (button may briefly
  // disable right after typing), with a raw-Enter fallback each round.
  const clickSend = `(()=>{const b=document.querySelector('[data-testid=send-button]')||[...document.querySelectorAll('button')].find(x=>/发送|Send/i.test(x.getAttribute('aria-label')||''));if(!b)return 'nobtn';if(b.disabled)return 'disabled';b.click();return 'ok';})()`;
  for (let i = 0; i < 5; i++) {
    await evalOn(c, clickSend); await sleep(900);
    if ((await userCount(c)) > before) return; // submitted
    await submitEnter(c); await sleep(700);
    if ((await userCount(c)) > before) return;
  }
  throw new Error('提交失败：消息未发出（composer 已填好但未产生 user 消息）');
}

// Reassemble the assistant's final-answer MARKDOWN from captured ChatGPT conversation WebSocket
// frames. Content is delivered over a WS (not the /f/conversation POST, which only hands off):
// each content frame is JSON nesting an `encoded_item` — an SSE blob of `event:`/`data:` lines in
// the delta_encoding v1 protocol. We collect the string appends to the assistant TEXT message's
// /content/parts/0. This yields the raw markdown (##, **, `code`, -, | tables) — unlike the DOM
// whose innerText has all markers rendered away.
function assembleMarkdown(frames) {
  const datas = [];
  for (const f of frames) {
    let arr; try { arr = JSON.parse(f); } catch { continue; }
    for (const m of (Array.isArray(arr) ? arr : [arr])) {
      const ei = m?.payload?.payload?.encoded_item;
      if (typeof ei !== 'string') continue;
      for (const line of ei.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const body = s.slice(5).trim();
        if (!body || body === '[DONE]' || body === '"v1"') continue;
        try { datas.push(JSON.parse(body)); } catch {}
      }
    }
  }
  const st = { buf: '', appending: false, haveFinal: false };
  // apply one op to the accumulator. `append` to /content/parts/ (or a bare continuation) grows
  // the answer text; everything else (status/metadata replaces) is ignored.
  const applyOp = (op) => {
    if (!op) return;
    if (op.o === 'append' && typeof op.v === 'string') {
      if (typeof op.p === 'string' && op.p.includes('/content/parts/')) st.appending = st.haveFinal;
      if (st.appending) st.buf += op.v;
    } else if (op.o == null && !('p' in op) && typeof op.v === 'string') { // bare continuation append
      if (st.appending) st.buf += op.v;
    }
  };
  for (const d of datas) {
    if (d && d.v && typeof d.v === 'object' && !Array.isArray(d.v) && d.v.message) { // a message was added
      const msg = d.v.message;
      if (msg.author?.role === 'assistant' && msg.content?.content_type === 'text') {
        st.haveFinal = true; st.appending = true;
        st.buf = (msg.content.parts && typeof msg.content.parts[0] === 'string') ? msg.content.parts[0] : '';
      } else { st.appending = false; }                                   // system/reasoning/user msg
    } else if (d && d.o === 'patch' && Array.isArray(d.v)) {             // batched sub-ops (tail content
      for (const sub of d.v) applyOp(sub);                               //   arrives inside a patch!)
    } else {
      applyOp(d);
    }
  }
  return st.buf.trim();
}

async function ask(prompt, timeoutSec = 300) {
  const model = process.env.ASKGPT_MODEL || 'GPT-5.6 Sol';
  const level = process.env.ASKGPT_LEVEL || 'Pro';
  const plain = process.env.ASKGPT_PLAIN === '1' || process.env.ASKGPT_PLAIN === 'true';
  const t = await ensureCleanPage();
  const c = client(t.webSocketDebuggerUrl); await c.ready;
  await c.send('Runtime.enable'); await c.send('Input.enable').catch(() => {});
  await c.send('Network.enable');
  // capture the conversation content WebSocket frames; the stream ends with message_stream_complete
  const frames = []; let streamDone = false, lastFrameAt = 0;
  c.on((method, params) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const d = params?.response?.payloadData;
    if (typeof d !== 'string') return;
    frames.push(d); lastFrameAt = Date.now();
    if (d.includes('message_stream_complete') || d.includes('"is_complete": true')) streamDone = true;
  });
  await ensureModel(c, model, level);
  const baseMd = await evalOn(c, `document.querySelectorAll('.markdown, .prose').length`);

  // DOM read — a backstop completion signal + the plain-text / parse-failure fallback. The answer
  // prose is the LAST `.markdown` (NOT [data-message-author-role=assistant]: an empty assistant
  // wrapper is the last such node). `streaming-animation` class = the turn is still being written.
  const READ = `(()=>{const mds=[...document.querySelectorAll('.markdown, .prose')];
    if(mds.length<=${baseMd})return {txt:'',streaming:!!document.querySelector('[data-testid=stop-button]'),fresh:false};
    const md=mds[mds.length-1];const txt=md.innerText||'';
    const streaming=/streaming-animation|result-streaming/.test(md.className||'')||!!md.querySelector('.streaming-animation')||!!document.querySelector('[data-testid=stop-button]');
    return {txt,streaming,fresh:true};})()`;

  frames.length = 0; streamDone = false; lastFrameAt = 0;   // ignore anything before our turn
  await submitPrompt(c, prompt);

  const deadline = Date.now() + timeoutSec * 1000;
  let last = '', prev = null, stable = 0, sawStreaming = false;
  while (Date.now() < deadline) {
    if (streamDone) break;                        // primary: WS says the turn is complete
    await sleep(700);
    const st = await evalOn(c, READ);             // backstop via the DOM
    if (st.fresh && st.txt) last = st.txt;
    if (st.streaming) { sawStreaming = true; stable = 0; prev = st.txt; continue; }
    if (!sawStreaming) continue;
    // DOM-stable backstop, but only fire once the WS has been quiet ≥2s (no content frame
    // mid-flight) so we never assemble a half-streamed answer.
    const wsQuiet = Date.now() - lastFrameAt > 2000;
    if (st.fresh && st.txt && st.txt === prev && wsQuiet) { if (++stable >= 3) break; } else stable = 0;
    prev = st.fresh ? st.txt : prev;
  }
  // wait out any trailing content frames (until the WS goes quiet ~1s or a short cap)
  for (let i = 0; i < 8 && Date.now() - lastFrameAt < 1000; i++) await sleep(300);

  let out = plain ? '' : assembleMarkdown(frames);
  if (!out) { const f = await evalOn(c, READ); out = (f.txt || last); } // plain mode, or WS parse empty
  c.close();
  return out.trim();
}

async function newChat() {
  const t = await ensureCleanPage();
  const c = client(t.webSocketDebuggerUrl); await c.ready; await c.send('Page.enable');
  await c.send('Page.navigate', { url: 'https://chatgpt.com/' });
  await sleep(3000); c.close();
  return 'new chat ready';
}

async function main() {
  const argv = process.argv.slice(2);
  let cmd = argv[0];
  if (!['ask', 'new', 'setup', 'status'].includes(cmd)) { cmd = 'ask'; } else { argv.shift(); }
  try {
    if (cmd === 'status') {
      const wv = await findWebview(); const pg = await findCleanLoggedInPage();
      console.log(JSON.stringify({ cdp: true, webviewLoggedInSession: !!wv, cleanPageReady: !!pg }, null, 2));
    } else if (cmd === 'setup') {
      const t = await ensureCleanPage(); console.log('setup OK, clean page:', t.url);
    } else if (cmd === 'new') {
      console.log(await newChat());
    } else {
      const prompt = argv[0];
      const timeout = parseInt(argv[1] || '300', 10);
      if (!prompt) { console.error('usage: askgpt "your question" [timeoutSec]  (default GPT-5.6 Sol + Pro, output is markdown; ASKGPT_MODEL/ASKGPT_LEVEL to override the model, ASKGPT_PLAIN=1 for plain text)'); process.exit(1); }
      const ans = await ask(prompt, timeout);
      process.stdout.write((ans || '(空 / 超时)') + '\n');
    }
  } catch (e) {
    console.error('ERROR:', String(e.message || e));
    process.exit(1);
  }
}
main();
