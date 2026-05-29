/**
 * SiteSureLabs — premium floating landing assistant.
 * Streams from POST /api/chat/landing/stream (Gemma via backend vLLM).
 */

import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

/** Pixels from bottom to treat as “following” the stream (same env as AI Analysis). */
const _nearRaw = import.meta.env.VITE_CHAT_SCROLL_NEAR_BOTTOM_PX;
const _nearParsed = Number.parseInt(String(_nearRaw ?? ""), 10);
const SCROLL_NEAR_BOTTOM_PX =
  Number.isFinite(_nearParsed) && _nearParsed > 0 ? _nearParsed : 100;

function apiBase() {
  const base = import.meta.env.VITE_API_BASE_URL;
  if (typeof base === "string" && base.trim() !== "") {
    return base.trim().replace(/\/$/, "");
  }
  return "";
}

function landingStreamUrl() {
  return `${apiBase()}/api/chat/landing/stream`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Double-check (sent) — white on blue bubble */
const DELIVERED_TICKS_SVG = `<svg class="ssl-assistant-double-tick" viewBox="0 0 20 12" width="20" height="12" aria-hidden="true">
  <path d="M1.5 6.5L4.5 9.5 10.5 2.5" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M5.5 6.5L8.5 9.5 18.5 1.5" fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/** Premium AI assistant doll — modern young professional with bob hair, raised waving hand. */
const MASCOT_SVG = `
<svg class="ssl-mascot__svg" viewBox="0 0 72 78" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="ssl-skin" x1="36" y1="16" x2="36" y2="54" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fbdcb8"/>
      <stop offset="1" stop-color="#e6b48a"/>
    </linearGradient>
    <linearGradient id="ssl-hair" x1="36" y1="4" x2="36" y2="48" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1f140d"/>
      <stop offset="1" stop-color="#3a2418"/>
    </linearGradient>
    <linearGradient id="ssl-top" x1="36" y1="50" x2="36" y2="82" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1e293b"/>
      <stop offset="1" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="ssl-hair-shine" x1="36" y1="6" x2="36" y2="18" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5a3b2a" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#5a3b2a" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Body / blouse -->
  <g class="ssl-mascot__body">
    <ellipse cx="36" cy="70" rx="22" ry="14" fill="url(#ssl-top)"/>
    <!-- V-neck collar showing neck -->
    <path d="M30 56 L36 64 L42 56 L42 60 Q36 65 30 60 Z" fill="url(#ssl-skin)"/>
    <!-- Soft shoulder highlight -->
    <path d="M18 64 Q26 60 36 60 Q46 60 54 64" stroke="rgba(255,255,255,0.06)" stroke-width="1.2" fill="none"/>
  </g>

  <!-- Hidden arm (left, behind body — subtle peek) -->
  <g class="ssl-mascot__arm ssl-mascot__arm--peek">
    <path d="M18 56 Q15 62 13 70" stroke="url(#ssl-skin)" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.5"/>
  </g>

  <!-- Waving arm (raised up, pivots around shoulder ~52,46) -->
  <g class="ssl-mascot__arm ssl-mascot__arm--wave">
    <!-- Sleeve from shoulder going up -->
    <path d="M52 50 Q55 40 56 32" stroke="url(#ssl-top)" stroke-width="6" stroke-linecap="round" fill="none"/>
    <!-- Forearm (skin) -->
    <path d="M56 34 Q61 26 64 18" stroke="url(#ssl-skin)" stroke-width="5" stroke-linecap="round" fill="none"/>
    <!-- Hand -->
    <circle cx="64" cy="16" r="5.2" fill="url(#ssl-skin)"/>
    <!-- Fingers (subtle premium detail) -->
    <path d="M62 13 q2-1 4 0" stroke="#c89578" stroke-width="0.55" stroke-linecap="round" fill="none" opacity="0.55"/>
    <path d="M62 15.5 q2-0.5 4 0" stroke="#c89578" stroke-width="0.55" stroke-linecap="round" fill="none" opacity="0.55"/>
    <path d="M62 18 q2 0 4 0.5" stroke="#c89578" stroke-width="0.55" stroke-linecap="round" fill="none" opacity="0.55"/>
    <!-- Wrist cuff hint -->
    <ellipse cx="60" cy="22" rx="2.5" ry="1.4" fill="url(#ssl-top)" opacity="0.85"/>
  </g>

  <!-- Head -->
  <g class="ssl-mascot__head">
    <!-- Hair back silhouette (bob length, jaw-line) -->
    <path d="M22 32
             C 21 14, 30 6, 36 6
             C 42 6, 51 14, 50 32
             C 49 38, 49 44, 48 48
             Q 44 46, 40 44
             L 36 42 L 32 44
             Q 28 46, 24 48
             C 23 44, 22 38, 22 32 Z"
          fill="url(#ssl-hair)"/>
    <!-- Hair highlight (premium glossy touch) -->
    <path d="M26 14 Q 31 9, 36 9 Q 41 9, 46 14 Q 42 11, 36 11 Q 30 11, 26 14 Z"
          fill="url(#ssl-hair-shine)"/>

    <!-- Ears -->
    <ellipse cx="23" cy="33" rx="1.5" ry="2.6" fill="url(#ssl-skin)"/>
    <ellipse cx="49" cy="33" rx="1.5" ry="2.6" fill="url(#ssl-skin)"/>

    <!-- Earrings (gold studs — premium accent) -->
    <circle cx="22.5" cy="36" r="0.95" fill="#fbbf24"/>
    <circle cx="49.5" cy="36" r="0.95" fill="#fbbf24"/>
    <circle cx="22.6" cy="35.8" r="0.32" fill="#fef3c7"/>
    <circle cx="49.6" cy="35.8" r="0.32" fill="#fef3c7"/>

    <!-- Face -->
    <ellipse cx="36" cy="34" rx="11.5" ry="13" fill="url(#ssl-skin)"/>

    <!-- Side-swept bangs / fringe -->
    <path d="M25 23
             Q 28 16, 36 16
             Q 44 16, 47 23
             Q 45 21, 42 21
             L 40 25 L 36 23 L 32 25 L 30 21
             Q 27 21, 25 23 Z"
          fill="url(#ssl-hair)"/>

    <!-- Face features -->
    <g class="ssl-mascot__face">
      <!-- Eyebrows -->
      <path d="M27 28 Q30 26.6 33 28" stroke="url(#ssl-hair)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
      <path d="M39 28 Q42 26.6 45 28" stroke="url(#ssl-hair)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
      <!-- Eyes -->
      <ellipse class="ssl-mascot__eye ssl-mascot__eye--l" cx="30" cy="33" rx="1.6" ry="2.4" fill="#1e293b"/>
      <ellipse class="ssl-mascot__eye ssl-mascot__eye--r" cx="42" cy="33" rx="1.6" ry="2.4" fill="#1e293b"/>
      <!-- Eye shine -->
      <circle class="ssl-mascot__eye-shine" cx="30.5" cy="32" r="0.65" fill="#ffffff"/>
      <circle class="ssl-mascot__eye-shine" cx="42.5" cy="32" r="0.65" fill="#ffffff"/>
      <!-- Subtle blush -->
      <ellipse cx="27" cy="39" r="2.2" fill="#f9a8a8" opacity="0.32"/>
      <ellipse cx="45" cy="39" r="2.2" fill="#f9a8a8" opacity="0.32"/>
      <!-- Confident smile -->
      <path class="ssl-mascot__smile" d="M32 41 Q36 44 40 41" stroke="#a13a14" stroke-width="1.55" stroke-linecap="round" fill="none"/>
    </g>

    <!-- Blink lids -->
    <g class="ssl-mascot__blink" aria-hidden="true">
      <path class="ssl-mascot__lid ssl-mascot__lid--l" d="M28 33 Q30 31 32 33" stroke="url(#ssl-skin)" stroke-width="2.6" stroke-linecap="round" fill="none"/>
      <path class="ssl-mascot__lid ssl-mascot__lid--r" d="M40 33 Q42 31 44 33" stroke="url(#ssl-skin)" stroke-width="2.6" stroke-linecap="round" fill="none"/>
    </g>
  </g>
</svg>`;

const WELCOME_HTML = `
<div class="ssl-assistant-row ssl-assistant-row--assistant" data-welcome="1">
  <div class="ssl-assistant-bubble ssl-assistant-bubble--assistant">
    <p>Hi! I'm your <strong>AI Assistant</strong>. I can explain what SiteSureLabs does, how defect detection fits your workflow, and how to use our tools.</p>
    <p style="margin-top:0.5em;margin-bottom:0">What would you like to know?</p>
  </div>
</div>`;

const MASCOT_HINT_LINES = ["Hi, this is Varnika👋", "Your AI Assistant."];

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/**
 * @param {Array<{role: string, content: string}>} messages
 * @param {(t: string) => void} onChunk
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function consumeLandingSse(messages, onChunk) {
  const res = await fetch(landingStreamUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ messages }),
  });

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") detail = j.detail;
    } catch {
      detail = (await res.text()).slice(0, 400) || detail;
    }
    return { ok: false, error: detail };
  }

  if (!res.body) {
    return { ok: false, error: "No response body." };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          return { ok: true };
        }
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== "object") continue;
        if (obj.type === "chunk" && typeof obj.text === "string") {
          onChunk(obj.text);
        } else if (obj.type === "error") {
          return { ok: false, error: String(obj.detail || "Stream error") };
        }
      }
    }
  }
  return { ok: true };
}

export function mountLandingAssistant() {
  if (document.getElementById("ssl-assistant-root")) return;

  const tpl = document.createElement("template");
  tpl.innerHTML = `
      <div class="ass-ctl ssl-assistant-fab" id="ssl-assistant-fab">
        <p class="ssl-mascot-hint" id="ssl-mascot-hint" aria-hidden="true" aria-label="${MASCOT_HINT_LINES.join(". ")}"></p>
        <figure class="ssl-mascot" id="ssl-mascot" aria-hidden="true">${MASCOT_SVG}</figure>
        <button type="button" class="ssl-assistant-launcher" id="ssl-assistant-launcher" aria-label="Open AI Assistant — your guide is here to help" aria-expanded="false" aria-controls="ssl-assistant-panel">
          <span class="ssl-assistant-launcher__ripple" aria-hidden="true"></span>
          <svg class="ssl-assistant-launcher__glyph" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7.2 4.75h9.6c1.93 0 3.5 1.57 3.5 3.5v5.5c0 1.93-1.57 3.5-3.5 3.5h-2.65L9.25 20.2V16.75H7.2c-1.93 0-3.5-1.57-3.5-3.5V8.25c0-1.93 1.57-3.5 3.5-3.5z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
            <circle cx="9.15" cy="10.35" r="0.95" fill="currentColor"/>
            <circle cx="12" cy="10.35" r="0.95" fill="currentColor"/>
            <circle cx="14.85" cy="10.35" r="0.95" fill="currentColor"/>
          </svg>
          <span class="ssl-assistant-launcher__label">Assistant</span>
        </button>
      </div>

      <div class="ass-ctl ssl-assistant-panel" id="ssl-assistant-panel" role="dialog" aria-modal="true" aria-labelledby="ssl-assistant-title" hidden>
        <header class="ssl-assistant-panel__header">
          <div class="ssl-assistant-panel__meta">
            <h2 class="ssl-assistant-panel__title" id="ssl-assistant-title">AI Assistant</h2>
            <div class="ssl-assistant-panel__status">
              <span class="ssl-assistant-panel__status-dot" aria-hidden="true"></span>
              <span>Online</span>
            </div>
          </div>
          <div class="ssl-assistant-panel__actions">
            <button type="button" class="ssl-assistant-panel__icon-btn" id="ssl-assistant-minimize" aria-label="Close assistant">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </header>
        <div class="ssl-assistant-messages" id="ssl-assistant-messages" role="log" aria-relevant="additions"></div>
        <div class="ssl-assistant-error" id="ssl-assistant-error" role="alert"></div>
        <div class="ssl-assistant-typing" id="ssl-assistant-typing" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <footer class="ssl-assistant-composer">
          <div class="ssl-assistant-composer__wrap">
            <label class="visually-hidden" for="ssl-assistant-input">Message</label>
            <textarea id="ssl-assistant-input" class="ssl-assistant-input" rows="1" placeholder="Ask about defects" autocomplete="off"></textarea>
            <button type="button" class="ssl-assistant-send" id="ssl-assistant-send" aria-label="Send message">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
          </div>
        </footer>
      </div>
  `.trim();

  const root = document.createElement("div");
  root.id = "ssl-assistant-root";
  root.setAttribute("aria-live", "polite");
  while (tpl.content.firstChild) {
    root.appendChild(tpl.content.firstChild);
  }

  /** @type {Array<{role: string, content: string}>} */
  const thread = [];
  let welcomeShown = false;
  let streaming = false;

  const fab = root.querySelector("#ssl-assistant-fab");
  const launcher = root.querySelector("#ssl-assistant-launcher");
  const mascotHint = root.querySelector("#ssl-mascot-hint");
  const panel = root.querySelector("#ssl-assistant-panel");
  const messagesEl = root.querySelector("#ssl-assistant-messages");
  const typingEl = root.querySelector("#ssl-assistant-typing");
  const errorEl = root.querySelector("#ssl-assistant-error");
  const inputEl = root.querySelector("#ssl-assistant-input");
  const sendBtn = root.querySelector("#ssl-assistant-send");
  const minimizeBtn = root.querySelector("#ssl-assistant-minimize");

  const showError = (msg) => {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.add("is-visible");
  };
  const hideError = () => {
    if (!errorEl) return;
    errorEl.textContent = "";
    errorEl.classList.remove("is-visible");
  };

  /**
   * Sticky-bottom scroll (aligned with `ai-analysis.js`):
   * - `userHasScrolledUp` — any user scroll that decreases scrollTop disables follow until user returns to bottom band.
   * - `captureStickyBottom` — only true if `!userHasScrolledUp && isNearBottom` before DOM updates.
   * - `programmaticScroll` — ignores our own scrollTop writes in the scroll listener.
   */
  const distanceFromBottom = () => {
    if (!messagesEl) return Number.POSITIVE_INFINITY;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  };
  const isNearBottom = () =>
    !!messagesEl && distanceFromBottom() <= SCROLL_NEAR_BOTTOM_PX;

  let isUserNearBottom = true;
  let userHasScrolledUp = false;
  let lastScrollTop = 0;
  let programmaticScroll = false;

  if (messagesEl) {
    lastScrollTop = messagesEl.scrollTop;
    messagesEl.addEventListener(
      "scroll",
      () => {
        if (!messagesEl) return;
        if (programmaticScroll) {
          lastScrollTop = messagesEl.scrollTop;
          programmaticScroll = false;
          isUserNearBottom = isNearBottom();
          if (isNearBottom()) {
            userHasScrolledUp = false;
          }
          return;
        }
        const st = messagesEl.scrollTop;
        if (st < lastScrollTop - 0.5) {
          userHasScrolledUp = true;
        }
        lastScrollTop = st;
        isUserNearBottom = isNearBottom();
        if (isNearBottom()) {
          userHasScrolledUp = false;
        }
      },
      { passive: true },
    );
    isUserNearBottom = isNearBottom();
  }

  const captureStickyBottom = () => {
    if (!messagesEl || userHasScrolledUp) return false;
    return isNearBottom();
  };

  const applyStickyScrollAfter = (wasNearBottom) => {
    if (!wasNearBottom || !messagesEl) return;
    programmaticScroll = true;
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      lastScrollTop = messagesEl.scrollTop;
      isUserNearBottom = true;
      queueMicrotask(() => {
        if (programmaticScroll) programmaticScroll = false;
      });
    });
  };

  /** force: welcome / intentional jump — resets follow and scrolls. */
  const scrollToBottom = (force = false) => {
    if (!messagesEl) return;
    if (!force) {
      if (userHasScrolledUp || !isNearBottom()) return;
    } else {
      userHasScrolledUp = false;
    }
    programmaticScroll = true;
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      lastScrollTop = messagesEl.scrollTop;
      isUserNearBottom = true;
      queueMicrotask(() => {
        if (programmaticScroll) programmaticScroll = false;
      });
    });
  };

  const syncInputHeight = () => {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    const max = 120;
    inputEl.style.height = `${Math.min(max, inputEl.scrollHeight)}px`;
  };

  /** @returns {HTMLElement | null} User bubble element (for delivered ticks). */
  const appendUserBubble = (text) => {
    const row = el(`
      <div class="ssl-assistant-row ssl-assistant-row--user">
        <div class="ssl-assistant-bubble ssl-assistant-bubble--user">
          <div class="ssl-assistant-bubble__content">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
          <span class="ssl-assistant-bubble__ticks" aria-hidden="true"></span>
        </div>
      </div>`);
    const wasNear = captureStickyBottom();
    messagesEl?.appendChild(row);
    applyStickyScrollAfter(wasNear);
    return row.querySelector(".ssl-assistant-bubble--user");
  };

  const markUserBubbleDelivered = (bubbleEl) => {
    if (!bubbleEl) return;
    const ticks = bubbleEl.querySelector(".ssl-assistant-bubble__ticks");
    if (ticks) ticks.innerHTML = DELIVERED_TICKS_SVG;
    bubbleEl.classList.add("is-delivered");
    bubbleEl.setAttribute("aria-label", "You — sent");
  };

  const appendAssistantShell = () => {
    const row = el(`
      <div class="ssl-assistant-row ssl-assistant-row--assistant" data-streaming="1">
        <div class="ssl-assistant-bubble ssl-assistant-bubble--assistant">
          <div class="insp-msg__md-inner ssl-assistant-md-stream"></div>
        </div>
      </div>`);
    const wasNear = captureStickyBottom();
    messagesEl?.appendChild(row);
    applyStickyScrollAfter(wasNear);
    return row.querySelector(".ssl-assistant-md-stream");
  };

  const ensureWelcome = () => {
    if (welcomeShown || !messagesEl) return;
    welcomeShown = true;
    messagesEl.insertAdjacentHTML("beforeend", WELCOME_HTML);
    scrollToBottom(true);
  };

  const motionOk = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let greetTimer = 0;
  let greetTypeTimer = 0;
  const setMascotHintText = (line1 = "", line2 = "") => {
    if (!mascotHint) return;
    mascotHint.innerHTML = `
      <span class="ssl-mascot-hint__line">${escapeHtml(line1)}</span>
      <span class="ssl-mascot-hint__line">${escapeHtml(line2)}</span>
    `;
  };

  const streamMascotHint = () => {
    if (!mascotHint) return;
    window.clearInterval(greetTypeTimer);
    const fullText = MASCOT_HINT_LINES.join("\n");
    let idx = 0;
    setMascotHintText();
    greetTypeTimer = window.setInterval(() => {
      idx += 1;
      const [line1 = "", line2 = ""] = fullText.slice(0, idx).split("\n");
      setMascotHintText(line1, line2);
      if (idx >= fullText.length) window.clearInterval(greetTypeTimer);
    }, 28);
  };

  const playGreeting = () => {
    if (!fab || !motionOk() || panel?.classList.contains("is-open")) return;
    window.clearTimeout(greetTimer);
    window.clearInterval(greetTypeTimer);
    fab.classList.remove("is-greeting");
    void fab.offsetWidth;
    fab.classList.add("is-greeting");
    setMascotHintText();
    mascotHint?.classList.add("is-visible");
    streamMascotHint();
    greetTimer = window.setTimeout(() => {
      fab.classList.remove("is-greeting");
      mascotHint?.classList.remove("is-visible");
      window.clearInterval(greetTypeTimer);
    }, 3600);
  };

  const runMascotIntro = () => {
    if (!fab) return;
    fab.classList.add("is-intro");
    window.setTimeout(() => fab.classList.remove("is-intro"), 1400);
    if (motionOk()) window.setTimeout(playGreeting, 950);
  };

  const openPanel = () => {
    if (!panel || !launcher) return;
    hideError();
    fab?.classList.add("is-chat-open");
    mascotHint?.classList.remove("is-visible");
    fab?.classList.remove("is-greeting");
    panel.hidden = false;
    panel.classList.add("is-open");
    launcher.setAttribute("aria-expanded", "true");
    ensureWelcome();
    syncInputHeight();
    setTimeout(() => inputEl?.focus(), 280);
  };

  const closePanel = () => {
    if (!panel || !launcher) return;
    panel.classList.remove("is-open");
    launcher.setAttribute("aria-expanded", "false");
    fab?.classList.remove("is-chat-open");
    setTimeout(() => {
      if (!panel.classList.contains("is-open")) panel.hidden = true;
    }, 380);
  };

  const triggerRipple = () => {
    launcher?.classList.remove("is-rippling");
    void launcher?.offsetWidth;
    launcher?.classList.add("is-rippling");
    setTimeout(() => launcher?.classList.remove("is-rippling"), 600);
  };

  launcher?.addEventListener("click", () => {
    triggerRipple();
    if (panel?.classList.contains("is-open")) closePanel();
    else openPanel();
  });

  fab?.addEventListener("pointerenter", playGreeting);
  fab?.addEventListener("focusin", (e) => {
    if (e.target === launcher) playGreeting();
  });

  minimizeBtn?.addEventListener("click", () => closePanel());

  runMascotIntro();

  const send = async () => {
    if (streaming || !inputEl) return;
    const text = inputEl.value.trim();
    if (!text) return;

    hideError();
    inputEl.value = "";
    syncInputHeight();
    const userBubbleEl = appendUserBubble(text);
    thread.push({ role: "user", content: text });

    streaming = true;
    sendBtn?.setAttribute("disabled", "true");
    sendBtn?.classList.add("is-loading");
    typingEl?.classList.add("is-visible");
    typingEl?.setAttribute("aria-hidden", "false");

    const mdEl = appendAssistantShell();
    let acc = "";
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (mdEl) {
        const wasNear = captureStickyBottom();
        const src = acc.trim() ? acc : " ";
        mdEl.innerHTML = marked.parse(src);
        applyStickyScrollAfter(wasNear);
      }
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(flush);
    };

    const outcome = await consumeLandingSse(thread, (piece) => {
      typingEl?.classList.remove("is-visible");
      typingEl?.setAttribute("aria-hidden", "true");
      acc += piece;
      schedule();
    });

    typingEl?.classList.remove("is-visible");
    typingEl?.setAttribute("aria-hidden", "true");
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    flush();

    if (!outcome.ok) {
      showError(outcome.error || "Something went wrong.");
      mdEl?.closest("[data-streaming]")?.remove();
      thread.pop();
    } else {
      markUserBubbleDelivered(userBubbleEl);
      const trimmed = acc.trim();
      if (trimmed) {
        thread.push({ role: "assistant", content: trimmed });
        mdEl?.closest("[data-streaming]")?.removeAttribute("data-streaming");
      } else {
        mdEl?.closest("[data-streaming]")?.remove();
      }
    }

    streaming = false;
    sendBtn?.removeAttribute("disabled");
    sendBtn?.classList.remove("is-loading");
    inputEl?.focus();
  };

  sendBtn?.addEventListener("click", () => void send());
  inputEl?.addEventListener("input", () => syncInputHeight());
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel?.classList.contains("is-open")) {
      e.preventDefault();
      closePanel();
      launcher?.focus();
    }
  });

  /* visually-hidden for screen readers */
  if (!document.getElementById("ssl-assistant-widget-style-inject")) {
    const s = document.createElement("style");
    s.id = "ssl-assistant-widget-style-inject";
    s.textContent = `.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}`;
    document.head.appendChild(s);
  }

  document.body.appendChild(root);
}
