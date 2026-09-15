# askgpt

Ask your **ChatGPT desktop app** a question from the terminal — using your existing
**ChatGPT subscription** (no API key), at the **Pro** reasoning level — billed by your flat
monthly plan instead of per token.

Answers come back as real **GitHub‑flavored Markdown** (captured from the response stream,
not scraped off the DOM), and every question runs in a **temporary chat** by default — not
saved to your history.

```bash
askgpt "Explain idempotency in payments with one refund example."
```

`askgpt` drives the ChatGPT macOS desktop app (the current Codex‑kernel build) over the
Chrome DevTools Protocol (CDP). It types your prompt, sends it, waits for the answer to
finish streaming, and prints it to stdout — so you can pipe ChatGPT into scripts, editors,
or other tools.

> ⚠️ Unofficial. This automates the desktop app's UI; it is not an OpenAI API. It works with
> **your** logged‑in session and is subject to OpenAI's Terms of Use. See [Caveats](#caveats).

---

## Why this exists

The current ChatGPT macOS app (bundle id `com.openai.codex`) is an Electron app whose chat
area is an **embedded `chatgpt.com` `<webview>`**. Two things make naive automation fail:

- **macOS Accessibility can't see the chat.** The `<webview>` content runs in a separate
  renderer process; the AX tree exposes only a handful of native chrome nodes, not the page.
- **The webview can be pinned to an upsell route.** Depending on account state the logged‑in
  webview gets pushed to `chatgpt.com/?source=codex#pricing` and won't navigate away.

`askgpt` sidesteps both: it talks CDP, and instead of fighting the pinned webview it opens a
**fresh, clean `chatgpt.com` page** in the same browser and copies the session cookies into it
(details in [How it works](#how-it-works)).

---

## Requirements

- **macOS**
- The **ChatGPT desktop app** installed and **signed in** (bundle id `com.openai.codex`).
- **Node.js ≥ 22** (uses the global `fetch` and global `WebSocket` — no npm dependencies).

## Install

```bash
git clone https://github.com/yixin-1024/askgpt.git
cd askgpt
chmod +x askgpt askgpt.mjs
# optional: put it on your PATH
ln -s "$PWD/askgpt" /usr/local/bin/askgpt
```

There is nothing to `npm install` — `askgpt.mjs` is dependency‑free.

## Usage

```bash
askgpt "your question"          # ask (default: "latest" model + Pro tier, temporary chat, 300s)
askgpt "a hard question" 900    # custom timeout in seconds
askgpt new                      # start a fresh conversation (clears context)
askgpt setup                    # pre-create the clean logged-in page
askgpt status                   # show CDP / login / clean-page status
```

Consecutive `askgpt` calls land in the **same conversation**, so follow-ups keep their context
without re-sending it; `askgpt new` starts a fresh one.

**Budget your timeout.** The Pro tier really does think for a long time: in our testing a
short, well-scoped question came back in **~1m30s**, while one open-ended architecture
question was still reasoning **48 minutes** later (the stream sends `{"status":"IS_STREAMING"}`
heartbeats the whole time and no prose at all). A timed-out turn **fails with exit 1** rather
than printing a half answer — see `ASKGPT_PARTIAL` below.

The first run (or any run when the debug port isn't up) will **relaunch the ChatGPT app**
with a debug port. Your current window gets replaced and the pinned webview may show the
pricing page — that's expected and harmless; `askgpt` drives a separate clean page.

### Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `ASKGPT_MODEL` | `最新` / *latest* | Model family, matched by the label shown in the picker. The picker currently offers three. |
| `ASKGPT_LEVEL` | `Pro` | Reasoning tier. Five stops on the slider: *instant / medium / high / very high / Pro*. |
| `ASKGPT_TEMP`  | `1` | `0` opts out of temporary chat (the conversation is then saved to your history). |
| `ASKGPT_PLAIN` | – | `1` prints rendered plain text (DOM read) instead of Markdown. |
| `ASKGPT_PARTIAL` | – | `1` accepts a truncated answer on timeout. Off by default: a timeout exits `1`, with the partial text carried in the error message. |
| `ASKGPT_PORT`  | `9238` | CDP remote debugging port. |
| `ASKGPT_BUNDLE`| `com.openai.codex` | App bundle id to launch (wrapper only). |

The tier actually reached is echoed on **stderr** every run, so you can tell when a UI change
has silently downgraded you:

```
[askgpt] 强度档=6Pro（目标 最新 / Pro）
```

```bash
ASKGPT_LEVEL=高 askgpt "..."      # a faster tier when the question isn't that hard
ASKGPT_TEMP=0 askgpt "..."       # keep this one in your chat history
```

> Model and tier are matched by the **text the app renders**, so the exact strings depend on
> your ChatGPT UI language. Sliding the tier all the way right shows `6Pro` in the composer.

---

## How it works

```
askgpt (bash)
  └─ if CDP not up: quit + relaunch app with --remote-debugging-port=9238 --remote-allow-origins=*
  └─ exec node askgpt.mjs
       ├─ ensureCleanPage()
       │    ├─ reuse an already logged-in chatgpt.com page target if one exists
       │    ├─ else Target.createTarget(...)                   # new top-level page (logged OUT: separate partition)
       │    ├─ [webview]  Network.getAllCookies                # read the logged-in session cookies
       │    └─ [new page] Network.setCookies + Page.navigate   # inject → reload → logged in on a clean chatgpt.com
       ├─ ensureTemporary()                                    # pin the page to /?temporary-chat=true
       ├─ ensureModel('latest', 'Pro')                         # picker button → model radio → reasoning slider
       ├─ submitPrompt()                                       # clear composer, insert text, click the real send button
       │      → POST /backend-api/f/conversation  (streams)
       ├─ capture the delta stream (WebSocket frames + a fetch() hook) → reassemble Markdown
       └─ verify the echoed question, then print the answer
```

Key technical points:

1. **CDP with an origin allow-list.** The app is launched with
   `--remote-debugging-port=9238 --remote-allow-origins='*'`. Recent Chromium enforces an
   Origin allow-list on the CDP WebSocket upgrade; without `--remote-allow-origins` the
   connection is rejected with `403`.
2. **Cookie transplant to bypass the pricing pin.** A brand-new page target lives in the
   default storage partition and is logged out. Copying the webview's `chatgpt.com` cookies
   (including the httpOnly session token) into it, then reloading, produces a logged-in page
   on plain `chatgpt.com` — with no `source=codex` marker, so no pricing pin.
3. **Send by clicking the button, not Enter.** Synthesized `Enter` (even `rawKeyDown`) and
   synthesized mouse clicks at coordinates do **not** make Lexical submit on a fresh page.
   Only invoking the button's own handler works:
   `document.querySelector('[data-testid=send-button]').click()`. The composer is also cleared
   first (focus + `Cmd+A` + Delete) because `Input.insertText` **appends**, and ChatGPT restores
   unsent drafts across navigations.
4. **Model & tier picker.** The first `button[aria-haspopup=menu]` in the composer form is the
   *"+ add files"* button — clicking it opens the wrong menu and every later click silently
   no-ops, leaving you on whatever tier the page happened to be on. Filter it out by
   `data-testid !== 'composer-plus-btn'`. Inside
   `[data-testid=composer-intelligence-picker-content]`, the model family is a
   `menuitemradio`, but the reasoning tier is a **`[role=slider]`** with `aria-valuenow` 0..4
   driven by arrow keys. Picking a model closes the picker, so it has to be reopened before
   touching the slider. The tier actually reached is echoed on stderr.
5. **Reading the answer: capture the stream, don't scrape the DOM.** The turn arrives as
   `delta_encoding v1` SSE over **two** transports and both have to be watched: normal tiers
   push it through the conversation **WebSocket** (`Network.webSocketFrameReceived`, payload
   nested in `payload.payload.encoded_item`), while **Pro** writes the SSE straight into the
   `/f/conversation` **fetch response body** — so a WebSocket-only listener gets two content-free
   frames and falls back to plain text. `askgpt` hooks `window.fetch`, tees the body, and feeds
   both sources to one parser. Trailing content often hides inside `{"o":"patch","v":[...]}`
   sub-ops; miss those and the answer ends mid-sentence.
6. **Completion & safety checks.** `"type":"message_stream_complete"` is the authoritative
   end-of-turn signal; a DOM-stability backstop only fires once the stream has been quiet for
   ≥2s. The DOM read is scoped to `[data-message-author-role=assistant]` — since a 2026-09 UI
   change the **user's own bubble also carries `markdown prose`**, so "the last `.markdown` on
   the page" could be your own question. And the last user message is compared against the
   prompt before the answer is accepted, so a mid-flight navigation that makes ChatGPT re-submit
   a restored draft fails loudly instead of returning the previous turn's answer.

Zero runtime dependencies: `askgpt.mjs` speaks CDP directly using Node's built-in global
`fetch` and `WebSocket`.

### Why not just call the endpoint with curl?

Tried; it does not work. Requests from outside the app get a Cloudflare `403` (TLS
fingerprint / device check), and `sentinel/chat-requirements` demands both
`proofofwork.required` and `turnstile.required` — and Turnstile has to be solved by a real
browser. Driving the app is what gets you past all three for free.

---

## Caveats

- **Unofficial & UI‑dependent.** It automates the desktop app's web UI. A ChatGPT UI change
  can break the selectors (`#prompt-textarea`, `send-button`, `composer-intelligence-picker-content`,
  the Stop button). PRs welcome.
- **Uses your logged-in session.** Prompts run under your account. By default they run in a
  *temporary chat*, so they do not appear in your history (`ASKGPT_TEMP=0` opts back in).
  Respect OpenAI's Terms of Use; don't use it for prohibited automation or abuse.
- **Quota.** It consumes your normal ChatGPT (subscription) quota for whichever model you pick.
- **First run relaunches the app** with a debug port (see [Usage](#usage)).
- **Local only.** All traffic is to `127.0.0.1:<port>` CDP on your own machine; nothing is
  sent anywhere else and no credentials are stored by this tool.

## Troubleshooting

| Symptom | What it means |
|---|---|
| `No logged-in webview` | The ChatGPT app isn't running or isn't signed in. Open it and log in. |
| `cookie 复制后仍未登录` | Usually a cold start: the page hadn't hydrated yet. Re-run — the second run reuses the now-logged-in page. |
| `发出的消息不是本次的问题` | The page navigated mid-send and ChatGPT re-submitted a restored draft. The echo check caught it; just re-run. |
| Timeout, exit `1` | The tier was still thinking. Re-run with a bigger timeout, or a lower `ASKGPT_LEVEL`. |
| `打不开模型/强度选择器` / `找不到强度滑块` | ChatGPT changed its composer UI; the selectors in `askgpt.mjs` need updating. |

`askgpt status` prints CDP / login / clean-page / temporary-chat state.

## License

MIT — see [LICENSE](LICENSE).
