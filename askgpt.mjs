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
// Output is the assistant's raw GFM MARKDOWN, reassembled from the conversation delta stream (the
// app still runs — it maintains the session and passes Cloudflare/Sentinel for us — but we read
// the network stream, not the DOM). Two transports carry the same delta_encoding v1 SSE: a
// WebSocket for normal models, and the /f/conversation POST response body for Pro; we capture
// both. Set ASKGPT_PLAIN=1 for rendered plain text (DOM fallback).
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
// Default to a *temporary chat* (not saved to history / not used for training). The query param
// survives sending messages — the "临时聊天" H1 and its close button do not — so the URL is the
// only reliable "am I still in a temp chat" signal. ASKGPT_TEMP=0 opts back into normal chats.
const TEMP_CHAT = !['0', 'false', 'no'].includes((process.env.ASKGPT_TEMP || '1').toLowerCase());
const CHAT_URL = TEMP_CHAT ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/';
const isTempChat = (href) => /[?&]temporary-chat=true/.test(href || '');

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
  await pg.send('Page.navigate', { url: CHAT_URL });
  await sleep(6000);
  const st = await evalOn(pg, CHECK_LOGIN); pg.close();
  return st;
}

async function createCleanPage() {
  const b = client(await browserWs()); await b.ready;
  const { targetId } = await b.send('Target.createTarget', { url: CHAT_URL });
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

// If the reusable page isn't in a temporary chat, navigate it there (rather than spawning yet
// another target). A page already sitting in a temp chat is left alone, so follow-up questions
// keep their context.
async function ensureTemporary(t) {
  if (!TEMP_CHAT) return t;
  const c = client(t.webSocketDebuggerUrl); await c.ready;
  await c.send('Runtime.enable'); await c.send('Page.enable');
  if (isTempChat(await evalOn(c, `location.href`))) { c.close(); return t; }
  await c.send('Page.navigate', { url: CHAT_URL });
  // Wait for the NEW document, never the outgoing one: the old page keeps its #prompt-textarea
  // for a moment, and returning early let the navigation land in the middle of typing — ChatGPT
  // then restored its saved draft and submitted THAT, so we silently answered the previous
  // question. Require the temp-chat href + a finished document + a composer.
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const st = await evalOn(c, `(()=>({href:location.href,ready:document.readyState,composer:!!document.querySelector('#prompt-textarea')}))()`).catch(() => null);
    if (st && isTempChat(st.href) && st.ready === 'complete' && st.composer) { ok = true; break; }
  }
  await sleep(1200);   // let the SPA settle (draft restore, composer hydration)
  c.close();
  if (!ok) throw new Error('切换到临时聊天失败（UI 可能又变了；ASKGPT_TEMP=0 可回普通会话）');
  const ts = await listTargets();
  return ts.find(x => x.id === t.id) || t;
}

async function ensureCleanPage() {
  let t = await findCleanLoggedInPage();
  if (t) return await ensureTemporary(t);
  t = await createCleanPage();
  const st = await copyCookiesFromWebviewTo(t);
  if (!st.loggedIn) throw new Error('cookie 复制后仍未登录：' + JSON.stringify(st));
  // re-fetch the target (url changed)
  const ts = await listTargets();
  return await ensureTemporary(ts.find(x => x.id === t.id) || t);
}

// ---- composer model/level picker helpers ----
async function clickXY(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(70);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function pressEsc(c) { for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); }
// The intelligence picker trigger is the composer's `aria-haspopup=menu` button that is NOT the
// "+" attachment button — as of 2026-09 the plus button sorts first, so indexing [0] grabs the
// wrong one (it opens the attachment menu, and every model/level click silently no-ops).
const PICKER_BTN = `[...((document.querySelector('#prompt-textarea')||{}).closest?.('form')||document).querySelectorAll('button[aria-haspopup=menu]')].filter(x=>x.getAttribute('data-testid')!=='composer-plus-btn'&&x.getBoundingClientRect().width>0)[0]`;
const SW_LABEL = `(()=>{const b=${PICKER_BTN};return b?(b.textContent||'').replace(/\\s+/g,' ').trim():'';})()`;
const SW_CENTER = `(()=>{const b=${PICKER_BTN};if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
// Reasoning level is a 5-stop radix slider (aria-valuenow 0..4) driven by arrow keys, not a
// submenu of radios. Index → label, plus the aliases older callers/docs used.
const TIERS = ['即时', '中', '高', '极高', 'Pro'];
const TIER_ALIAS = { '极速': '即时', '快速': '即时', 'instant': '即时', 'pro': 'Pro', 'PRO': 'Pro', '6Pro': 'Pro' };
const tierIndex = (level) => TIERS.indexOf(TIER_ALIAS[level] || level);
const SLIDER_NOW = `(()=>{const s=document.querySelector('[role=slider]');const v=s&&s.getAttribute('aria-valuenow');return v==null?null:Number(v)})()`;
const SLIDER_FOCUS = `(()=>{const s=document.querySelector('[role=slider]');if(!s)return false;s.focus();return document.activeElement===s})()`;
const CHECKED_MODEL = `(()=>{const e=[...document.querySelectorAll('[role=menuitemradio]')].find(x=>x.getAttribute('aria-checked')==='true');return e?(e.textContent||'').replace(/\\s+/g,' ').trim():null})()`;
const menuOpen = c => evalOn(c, `!!document.querySelector('[data-testid=composer-intelligence-picker-content]')`);
const cByRT = (role, text) => `(()=>{const els=[...document.querySelectorAll('[role=${role}]')].filter(m=>(m.textContent||'').replace(/\\s+/g,' ').trim()===${JSON.stringify(text)}&&m.getBoundingClientRect().width>0);const e=els[els.length-1];if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
async function openMenu(c) { for (let i = 0; i < 4 && !(await menuOpen(c)); i++) { const s = await evalOn(c, SW_CENTER); if (s) await clickXY(c, s.x, s.y); await sleep(600); } return menuOpen(c); }

// ensure model family = `model` (a top-level radio) and reasoning level = `level` (the slider).
// Picking a model radio closes the picker, so the level pass reopens it.
async function ensureModel(c, model, level) {
  const want = tierIndex(level);
  await pressEsc(c); await sleep(250);
  if (!(await openMenu(c))) { console.error('[askgpt] 打不开模型/强度选择器，沿用页面当前档位'); return await evalOn(c, SW_LABEL); }

  if (model && (await evalOn(c, CHECKED_MODEL)) !== model) {
    const mo = await evalOn(c, cByRT('menuitemradio', model));
    if (mo) { await clickXY(c, mo.x, mo.y); await sleep(700); }  // closes the picker
    else console.error(`[askgpt] 选择器里找不到模型「${model}」，沿用当前模型`);
  }

  if (want >= 0) {
    if (!(await menuOpen(c)) && !(await openMenu(c))) { console.error('[askgpt] 重开选择器失败，跳过强度设置'); return await evalOn(c, SW_LABEL); }
    let now = await evalOn(c, SLIDER_NOW);
    if (now == null) console.error('[askgpt] 找不到强度滑块（UI 可能又变了），跳过强度设置');
    else if (await evalOn(c, SLIDER_FOCUS)) {
      for (let guard = 0; guard < TIERS.length + 2 && now !== want; guard++) {
        const right = want > now;
        await pressKey(c, right ? 'ArrowRight' : 'ArrowLeft', right ? 'ArrowRight' : 'ArrowLeft', right ? 39 : 37);
        await sleep(280);
        const next = await evalOn(c, SLIDER_NOW);
        if (next === now) break;   // slider refused to move (clamped / detached)
        now = next;
      }
      if (now !== want) console.error(`[askgpt] 强度停在「${TIERS[now] ?? now}」，目标是「${TIERS[want]}」`);
    }
  } else if (level) console.error(`[askgpt] 未知强度档「${level}」（可选 ${TIERS.join('/')}），沿用当前档位`);

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
const LAST_USER_TEXT = `(()=>{const l=[...document.querySelectorAll('[data-message-author-role=user]')].pop();return l?(l.innerText||'').replace(/\\s+/g,''):''})()`;
// A bumped user-message count only proves *something* got sent. Confirm the turn that went out is
// OUR prompt — otherwise (mid-flight navigation, restored draft) we'd scrape the previous answer
// and hand it back as if it were fresh.
async function verifyEcho(c, prompt) {
  const want = prompt.replace(/\s+/g, '').slice(0, 24);
  if (!want) return;
  for (let i = 0; i < 6; i++) {
    if (((await evalOn(c, LAST_USER_TEXT)) || '').includes(want)) return;
    await sleep(400);
  }
  throw new Error('发出的消息不是本次的问题（页面可能中途跳转或恢复了旧草稿），请重跑');
}
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
    if ((await userCount(c)) > before) return await verifyEcho(c, prompt); // submitted
    await submitEnter(c); await sleep(700);
    if ((await userCount(c)) > before) return await verifyEcho(c, prompt);
  }
  throw new Error('提交失败：消息未发出（composer 已填好但未产生 user 消息）');
}

// Reassemble the assistant's final-answer MARKDOWN from the captured conversation stream, which
// arrives over one of two transports carrying the SAME delta_encoding v1 SSE protocol:
//   • normal models: a WebSocket, each frame JSON-nesting an `encoded_item` SSE blob;
//   • Pro (pro_mode_turn_topic_streaming): the SSE streams directly as the /f/conversation POST
//     response body (no WS, no encoded_item wrapper).
// We normalise both into SSE `data:` lines, then collect the string appends to the assistant TEXT
// message's /content/parts/0. Yields raw markdown (##, **, `code`, -, | tables) — unlike the DOM
// whose innerText has all markers rendered away.
function assembleMarkdown(frames, fetchSse) {
  const sseBlobs = [];
  for (const f of frames) {                     // WS frames -> unwrap encoded_item SSE blobs
    let arr; try { arr = JSON.parse(f); } catch { continue; }
    for (const m of (Array.isArray(arr) ? arr : [arr])) {
      const ei = m?.payload?.payload?.encoded_item;
      if (typeof ei === 'string') sseBlobs.push(ei);
    }
  }
  if (fetchSse) sseBlobs.push(fetchSse);        // Pro / resume-SSE: response body is raw SSE already
  const datas = [];
  for (const blob of sseBlobs) {
    for (const line of blob.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const body = s.slice(5).trim();
      if (!body || body === '[DONE]' || body === '"v1"') continue;
      try { datas.push(JSON.parse(body)); } catch {}
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
  const model = process.env.ASKGPT_MODEL || '最新';
  const level = process.env.ASKGPT_LEVEL || 'Pro';
  const plain = process.env.ASKGPT_PLAIN === '1' || process.env.ASKGPT_PLAIN === 'true';
  const t = await ensureCleanPage();
  const c = client(t.webSocketDebuggerUrl); await c.ready;
  await c.send('Runtime.enable'); await c.send('Input.enable').catch(() => {});
  await c.send('Network.enable');
  // Capture channel 1 — WebSocket frames (normal models). Stream ends with message_stream_complete.
  const frames = []; let streamDone = false, lastFrameAt = 0;
  c.on((method, params) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const d = params?.response?.payloadData;
    if (typeof d !== 'string') return;
    frames.push(d); lastFrameAt = Date.now();
    if (d.includes('message_stream_complete') || d.includes('"is_complete": true')) streamDone = true;
  });
  const tier = await ensureModel(c, model, level);
  console.error(`[askgpt] 强度档=${tier || '未知'}（目标 ${model} / ${level}）`);
  const A_SEL = '[data-message-author-role=assistant] .markdown, [data-message-author-role=assistant] .prose';
  // Scope to ASSISTANT turns only: since a 2026-09 UI change the *user* bubble also carries
  // `markdown prose`, so "the last .markdown on the page" was our own question — on a Pro turn
  // that hasn't produced text yet, that got returned as if it were the answer.
  const baseMd = await evalOn(c, `document.querySelectorAll('${A_SEL}').length`);

  // Capture channel 2 — the /f/conversation (and resume /stream) fetch response body, which is
  // where Pro streams its SSE directly. Tee the body into window.__ag_sse; window.__ag_done flips
  // when the stream-complete marker arrives. (Idempotent wrap; buffers reset each turn.)
  const HOOK = `(()=>{
    if(!window.__agHook){window.__agHook=1;window.__ag_sse='';window.__ag_done=false;
      const of=window.fetch;
      window.fetch=async(...a)=>{const url=((a[0]&&a[0].url)||a[0])+'';const res=await of(...a);
        try{if((url.indexOf('/f/conversation')>=0||url.indexOf('/stream')>=0)&&res.body){const cl=res.clone();const rd=cl.body.getReader();const dec=new TextDecoder();
          (async()=>{try{for(;;){const r=await rd.read();if(r.done)break;const txt=dec.decode(r.value,{stream:true});window.__ag_sse+=txt;if(txt.indexOf('message_stream_complete')>=0)window.__ag_done=true;}}catch(e){}})();}}catch(e){}
        return res;};}
    window.__ag_sse='';window.__ag_done=false;return 'ok';})()`;

  // DOM read — a backstop completion signal + the plain-text / parse-failure fallback. `done` folds
  // in the fetch-SSE completion flag. The answer prose is the LAST `.markdown` (an empty assistant
  // wrapper is the last [data-message-author-role=assistant] node); streaming-animation = writing.
  const READ = `(()=>{const mds=[...document.querySelectorAll('${A_SEL}')];const done=!!window.__ag_done;
    if(mds.length<=${baseMd})return {txt:'',streaming:!!document.querySelector('[data-testid=stop-button]'),done,fresh:false};
    const md=mds[mds.length-1];const txt=md.innerText||'';
    const streaming=/streaming-animation|result-streaming/.test(md.className||'')||!!md.querySelector('.streaming-animation')||!!document.querySelector('[data-testid=stop-button]');
    return {txt,streaming,done,fresh:true};})()`;

  frames.length = 0; streamDone = false; lastFrameAt = 0;   // ignore anything before our turn
  await evalOn(c, HOOK);
  await submitPrompt(c, prompt);

  const deadline = Date.now() + timeoutSec * 1000;
  let last = '', prev = null, stable = 0, sawStreaming = false, finished = false;
  while (Date.now() < deadline) {
    if (streamDone) { finished = true; break; }   // WS (normal models) says the turn is complete
    await sleep(700);
    const st = await evalOn(c, READ);
    if (st.done) { finished = true; break; }      // fetch-SSE (Pro) says the turn is complete
    if (st.fresh && st.txt) last = st.txt;
    if (st.streaming) { sawStreaming = true; stable = 0; prev = st.txt; continue; }
    if (!sawStreaming) continue;
    // DOM-stable backstop, but only fire once the WS has been quiet ≥2s (no content frame
    // mid-flight) so we never assemble a half-streamed answer.
    const wsQuiet = Date.now() - lastFrameAt > 2000;
    if (st.fresh && st.txt && st.txt === prev && wsQuiet) { if (++stable >= 3) { finished = true; break; } } else stable = 0;
    prev = st.fresh ? st.txt : prev;
  }
  // wait out any trailing content frames (until the WS goes quiet ~1s or a short cap)
  for (let i = 0; i < 8 && Date.now() - lastFrameAt < 1000; i++) await sleep(300);

  const fetchSse = await evalOn(c, `window.__ag_sse||''`);
  let out = plain ? '' : assembleMarkdown(frames, fetchSse);
  if (!out) { const f = await evalOn(c, READ); out = (f.txt || last); } // plain mode, or parse empty
  c.close();
  out = out.trim();
  // Fail loudly. A Pro turn can think for >10min with no assistant node on the page yet; returning
  // whatever text happened to be around (or an empty string) would silently pass off a non-answer
  // as the answer. The turn keeps running in the app — just re-ask with a bigger timeout.
  if (!out) throw new Error(finished
    ? '本轮结束但没抓到回答正文（页面结构可能又变了，用 ASKGPT_PLAIN=1 对比看看）'
    : `等待 ${timeoutSec}s 超时，回答还没写出来（Pro 档深度思考经常 >10min）——加大超时重试：askgpt "..." 900`);
  // A timed-out turn is NOT a success: a truncated answer on stdout with exit 0 looks exactly like
  // a complete one to whatever consumes it. Fail by default and carry the partial text inside the
  // error (so nothing is lost); callers that genuinely want the fragment opt in with ASKGPT_PARTIAL=1.
  if (!finished) {
    if (!['1', 'true', 'yes'].includes((process.env.ASKGPT_PARTIAL || '').toLowerCase())) {
      const e = new Error(`等待 ${timeoutSec}s 超时，回答只写了一半（${out.length} 字）——加大超时重试，或 ASKGPT_PARTIAL=1 接受残文\n--- 截至超时的部分正文 ---\n${out}`);
      e.partialText = out; throw e;
    }
    console.error(`[askgpt] ⚠️ 超时 ${timeoutSec}s，下面是截至超时已写出的部分，不完整`);
  }
  return out;
}

async function newChat() {
  const t = await ensureCleanPage();
  const c = client(t.webSocketDebuggerUrl); await c.ready; await c.send('Page.enable');
  await c.send('Page.navigate', { url: CHAT_URL });
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
      console.log(JSON.stringify({ cdp: true, webviewLoggedInSession: !!wv, cleanPageReady: !!pg, temporaryChatWanted: TEMP_CHAT, pageIsTemporaryChat: isTempChat(pg && pg.url) }, null, 2));
    } else if (cmd === 'setup') {
      const t = await ensureCleanPage(); console.log('setup OK, clean page:', t.url);
    } else if (cmd === 'new') {
      console.log(await newChat());
    } else {
      const prompt = argv[0];
      const timeout = parseInt(argv[1] || '300', 10);
      if (!prompt) { console.error('usage: askgpt "your question" [timeoutSec]  (defaults to the "latest" model + Pro tier in a temporary chat, output is markdown; ASKGPT_MODEL/ASKGPT_LEVEL to override the model, ASKGPT_TEMP=0 for a normal chat, ASKGPT_PLAIN=1 for plain text)'); process.exit(1); }
      const ans = await ask(prompt, timeout);
      process.stdout.write((ans || '(空 / 超时)') + '\n');
    }
  } catch (e) {
    console.error('ERROR:', String(e.message || e));
    process.exit(1);
  }
}
main();
