#!/usr/bin/env node
// askgpt.mjs — drive the ChatGPT desktop app (the current Codex-kernel build,
// bundle id `com.openai.codex`) from your terminal via the Chrome DevTools
// Protocol (CDP), asking a chosen model/reasoning level and printing the answer.
//
// It uses your logged-in ChatGPT session (subscription quota), NOT any API key.
//
// Why it is not trivial:
//   The desktop app renders chat as an embedded chatgpt.com <webview>. Depending
//   on account state that webview can get pushed to a "?source=codex#pricing"
//   upsell route and refuses to leave it. Instead of fighting that webview, we
//   open a *fresh* top-level chatgpt.com page in the same Electron browser and
//   copy the webview's auth cookies into it — a clean page has no "source=codex"
//   marker, so it lands on the normal chat UI.
//
// Requires the app launched with:  --remote-debugging-port=9238 --remote-allow-origins=*
// (the `askgpt` shell wrapper handles launching / relaunching it.)
//
// Requirements: macOS, Node >= 22 (uses global fetch + global WebSocket), and the
// ChatGPT desktop app installed and signed in.
//
// Usage:
//   node askgpt.mjs "your question" [timeoutSec]   # ask (default command)
//   node askgpt.mjs ask "..." [timeoutSec]
//   node askgpt.mjs new                            # start a fresh conversation
//   node askgpt.mjs setup                          # (re)create the clean logged-in page
//   node askgpt.mjs status
//
// Env: ASKGPT_MODEL (default "GPT-5.6 Sol"), ASKGPT_LEVEL (default "Pro"),
//      ASKGPT_PORT (default 9238).

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

// Minimal CDP JSON-RPC client over a target's WebSocket.
function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pend = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pend.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ready, send, close: () => ws.close() };
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
  if (!wvT) throw new Error('No logged-in webview found (open the ChatGPT app and sign in first).');
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
  for (let i = 0; i < 30; i++) {
    const ts = await listTargets();
    const t = ts.find(x => x.id === targetId && x.webSocketDebuggerUrl);
    if (t) return t;
    await sleep(400);
  }
  throw new Error('Timed out waiting for the new chatgpt.com page target.');
}

// Idempotent: reuse an existing clean logged-in page, else create one + inject cookies.
async function ensureCleanPage() {
  let t = await findCleanLoggedInPage();
  if (t) return t;
  t = await createCleanPage();
  const st = await copyCookiesFromWebviewTo(t);
  if (!st.loggedIn) throw new Error('Still not logged in after cookie copy: ' + JSON.stringify(st));
  const ts = await listTargets();
  return ts.find(x => x.id === t.id) || t;
}

// ---- composer model / reasoning-level picker helpers ----
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

// Ensure model family = `model` (submenu) and reasoning level = `level` (radio). Idempotent by label.
// Note: the picker is driven by the labels the app renders. "GPT-5.6 Sol" and "Pro" are locale-independent;
// other reasoning levels (Fast/Medium/High/... or their localized equivalents) use the app's displayed text.
async function ensureModel(c, model, level) {
  if ((await evalOn(c, SW_LABEL)) === level) return level; // level already set (model family persists per account)
  await pressEsc(c); await sleep(250);
  await openMenu(c);
  const parent = await evalOn(c, cByRT('menuitem', model));
  if (parent) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: parent.x, y: parent.y }); await sleep(800); // hover opens the submenu
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

// Send by CLICKING the real send button. Pressing Enter alone only fires
// /conversation/prepare (a prefetch) and does NOT submit the actual /conversation request.
async function sendViaButton(c, prompt) {
  await evalOn(c, `(()=>{const el=document.querySelector('#prompt-textarea');el&&el.focus();})()`); await sleep(150);
  await c.send('Input.insertText', { text: prompt }); await sleep(400);
  const typed = await evalOn(c, `(document.querySelector('#prompt-textarea')?.innerText||'').trim().length`);
  if (!typed) throw new Error('Could not type the prompt into the composer.');
  const sb = await evalOn(c, `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/send-button|composer-submit/i.test(x.getAttribute('data-testid')||'')||/发送|Send/i.test(x.getAttribute('aria-label')||''));if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),disabled:!!b.disabled};})()`);
  if (sb && !sb.disabled) await clickXY(c, sb.x, sb.y);
  else for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

async function ask(prompt, timeoutSec = 300) {
  const model = process.env.ASKGPT_MODEL || 'GPT-5.6 Sol';
  const level = process.env.ASKGPT_LEVEL || 'Pro';
  const t = await ensureCleanPage();
  const c = client(t.webSocketDebuggerUrl); await c.ready;
  await c.send('Runtime.enable'); await c.send('Input.enable').catch(() => {});
  await ensureModel(c, model, level);
  await sendViaButton(c, prompt);

  // "generating" signal = a Stop button in the composer (matched across locales).
  const READ = `(()=>{const as=document.querySelectorAll('[data-message-author-role=assistant]');const a=as.length?as[as.length-1]:null;const txt=a?a.textContent:'';const streaming=!!document.querySelector('button[aria-label*="Stop" i],button[aria-label*="停止"]');return {txt,streaming};})()`;
  const FINAL = `(()=>{const as=document.querySelectorAll('[data-message-author-role=assistant]');const a=as[as.length-1];return a?a.textContent:'';})()`;
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '', stable = 0, started = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    const st = await evalOn(c, READ);
    if (st.streaming) { started = true; last = st.txt; stable = 0; continue; }
    if (started) { await sleep(800); last = await evalOn(c, FINAL); break; } // streaming ended
    if (st.txt && st.txt.length > 0) { if (st.txt === last) { stable++; if (stable >= 3) break; } else { stable = 0; last = st.txt; } } // fast/instant answers
  }
  c.close();
  return last;
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
      if (!prompt) { console.error('usage: askgpt "your question" [timeoutSec]  (default model GPT-5.6 Sol + Pro; override via ASKGPT_MODEL / ASKGPT_LEVEL)'); process.exit(1); }
      const ans = await ask(prompt, timeout);
      process.stdout.write((ans || '(empty / timed out)') + '\n');
    }
  } catch (e) {
    console.error('ERROR:', String(e.message || e));
    process.exit(1);
  }
}
main();
