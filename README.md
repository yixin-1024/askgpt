# askgpt

Ask your **ChatGPT desktop app** a question from the terminal — using your existing
**ChatGPT subscription** (no API key), including the newest in-app models such as
**GPT‑5.6 Sol** at the **Pro** reasoning level.

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
askgpt "your question"          # ask (default model GPT-5.6 Sol + Pro, 300s timeout)
askgpt "a hard question" 600    # custom timeout in seconds
askgpt new                      # start a fresh conversation (clears context)
askgpt setup                    # pre-create the clean logged-in page
askgpt status                   # show CDP / login / clean-page status
```

The first run (or any run when the debug port isn't up) will **relaunch the ChatGPT app**
with a debug port. Your current window gets replaced and the pinned webview may show the
pricing page — that's expected and harmless; `askgpt` drives a separate clean page.

### Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `ASKGPT_MODEL` | `GPT-5.6 Sol` | Model family to select (matched by the label shown in the picker). |
| `ASKGPT_LEVEL` | `Pro` | Reasoning level (`Pro`, or the app's other levels such as Fast/Medium/High). |
| `ASKGPT_PORT`  | `9238` | CDP remote debugging port. |
| `ASKGPT_BUNDLE`| `com.openai.codex` | App bundle id to launch (wrapper only). |

```bash
ASKGPT_LEVEL=High askgpt "..."   # different reasoning level
```

> `GPT-5.6 Sol` and `Pro` are locale‑independent labels. Other reasoning levels are matched
> by the text the app renders, which may be localized in your ChatGPT UI language.

---

## How it works

```
askgpt (bash)
  └─ if CDP not up: quit + relaunch app with --remote-debugging-port=9238 --remote-allow-origins=*
  └─ exec node askgpt.mjs
       ├─ ensureCleanPage()
       │    ├─ Target.createTarget('https://chatgpt.com/')     # new top-level page (logged OUT: separate partition)
       │    ├─ [webview]  Network.getAllCookies                # read the logged-in session cookies
       │    └─ [new page] Network.setCookies + Page.navigate   # inject → reload → logged in on a clean chatgpt.com
       ├─ ensureModel('GPT-5.6 Sol', 'Pro')                    # drive the composer model/level picker
       ├─ sendViaButton(prompt)                                # type + click the real send button
       │      → POST /backend-api/f/conversation  (streams)
       └─ poll last assistant message until the Stop button disappears → print the answer
```

Key technical points:

1. **CDP with an origin allow‑list.** The app is launched with
   `--remote-debugging-port=9238 --remote-allow-origins='*'`. Recent Chromium enforces an
   Origin allow‑list on the CDP WebSocket upgrade; without `--remote-allow-origins` the
   connection is rejected with `403`.
2. **Cookie transplant to bypass the pricing pin.** A brand‑new page target lives in the
   default storage partition and is logged out. Copying the webview's ~20 `chatgpt.com`
   cookies (including the httpOnly session token) into it, then reloading, produces a
   logged‑in page on plain `chatgpt.com` — with no `source=codex` marker, so no pricing pin.
3. **Send by clicking the button, not Enter.** Pressing Enter only triggers
   `POST /conversation/prepare` (a prefetch); the actual submission
   (`POST /conversation`) never fires. `askgpt` clicks `[data-testid="send-button"]`.
4. **Model picker.** The composer toolbar button (`button[aria-haspopup=menu]`, whose text is
   the current level) opens `[data-testid=composer-intelligence-picker-content]`: reasoning
   levels are `menuitemradio`s; the model family is a `menuitem` with a hover‑opened submenu.
   Menu items are clicked with real mouse events (`Input.dispatchMouseEvent`); `Esc` resets
   state between steps.
5. **Completion detection.** A response is "generating" while a Stop button
   (`button[aria-label*="Stop"]` / `停止`) exists in the composer; when it disappears, the
   answer is read from the last `[data-message-author-role=assistant]` element.

Zero runtime dependencies: `askgpt.mjs` speaks CDP directly using Node's built‑in global
`fetch` and `WebSocket`.

---

## Caveats

- **Unofficial & UI‑dependent.** It automates the desktop app's web UI. A ChatGPT UI change
  can break the selectors (`#prompt-textarea`, `send-button`, `composer-intelligence-picker-content`,
  the Stop button). PRs welcome.
- **Uses your logged‑in session.** Prompts run under your account and appear in your ChatGPT
  history. Respect OpenAI's Terms of Use; don't use it for prohibited automation or abuse.
- **Quota.** It consumes your normal ChatGPT (subscription) quota for whichever model you pick.
- **First run relaunches the app** with a debug port (see [Usage](#usage)).
- **Local only.** All traffic is to `127.0.0.1:<port>` CDP on your own machine; nothing is
  sent anywhere else and no credentials are stored by this tool.

## License

MIT — see [LICENSE](LICENSE).
