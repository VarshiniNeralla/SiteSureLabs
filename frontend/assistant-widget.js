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

/** Cute girl peeking from behind the FAB — upper body only (legs hidden by the button). */
const MASCOT_SVG = `
<svg class="ssl-mascot__svg" viewBox="0 0 72 78" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="ssl-mascot-dress" x1="36" y1="48" x2="36" y2="78" gradientUnits="userSpaceOnUse">
      <stop stop-color="#60a5fa"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <linearGradient id="ssl-mascot-hair" x1="36" y1="4" x2="36" y2="28" gradientUnits="userSpaceOnUse">
      <stop stop-color="#4a3728"/>
      <stop offset="1" stop-color="#2c1f14"/>
    </linearGradient>
  </defs>
  <g class="ssl-mascot__body">
    <path d="M22 54c2 8 8 14 14 14s12-6 14-14c-2 4-8 8-14 8s-12-4-14-8z" fill="url(#ssl-mascot-dress)"/>
    <path d="M28 56h16v4c0 2-3 4-8 4s-8-2-8-4v-4z" fill="rgba(255,255,255,0.9)"/>
    <ellipse cx="36" cy="60" rx="2" ry="1.2" fill="#93c5fd" opacity="0.8"/>
  </g>
  <g class="ssl-mascot__arm ssl-mascot__arm--peek">
    <path d="M20 50c-4 4-6 10-5 16" stroke="#fde4d6" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="15" cy="66" r="2.8" fill="#fde4d6"/>
  </g>
  <g class="ssl-mascot__arm ssl-mascot__arm--wave">
    <path d="M52 46c6-2 12 2 14 10" stroke="#fde4d6" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="66" cy="54" r="3" fill="#fde4d6"/>
  </g>
  <g class="ssl-mascot__head">
    <ellipse cx="36" cy="34" rx="14" ry="15" fill="#fde4d6"/>
    <path class="ssl-mascot__hair-back" d="M22 28c0-12 6-20 14-20s14 8 14 20c-2-8-6-12-14-12s-12 4-14 12z" fill="url(#ssl-mascot-hair)"/>
    <path class="ssl-mascot__pigtail ssl-mascot__pigtail--l" d="M22 26c-8 4-10 14-6 22" stroke="url(#ssl-mascot-hair)" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path class="ssl-mascot__pigtail ssl-mascot__pigtail--r" d="M50 26c8 4 10 14 6 22" stroke="url(#ssl-mascot-hair)" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M24 18c2-6 8-10 12-10s10 4 12 10" fill="url(#ssl-mascot-hair)"/>
    <circle cx="36" cy="16" r="3.5" fill="#f472b6" opacity="0.85"/>
    <g class="ssl-mascot__face">
      <ellipse class="ssl-mascot__eye ssl-mascot__eye--l" cx="30" cy="33" rx="2.4" ry="3" fill="#1e293b"/>
      <ellipse class="ssl-mascot__eye ssl-mascot__eye--r" cx="42" cy="33" rx="2.4" ry="3" fill="#1e293b"/>
      <circle class="ssl-mascot__eye-shine" cx="31" cy="31.5" r="0.9" fill="#fff"/>
      <circle class="ssl-mascot__eye-shine" cx="43" cy="31.5" r="0.9" fill="#fff"/>
      <circle cx="26" cy="37" r="2.2" fill="#fda4af" opacity="0.45"/>
      <circle cx="46" cy="37" r="2.2" fill="#fda4af" opacity="0.45"/>
      <path class="ssl-mascot__smile" d="M31 40c1.5 2.5 4.5 3.5 7 2.5" stroke="#d97706" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    </g>
    <g class="ssl-mascot__blink" aria-hidden="true">
      <path class="ssl-mascot__lid ssl-mascot__lid--l" d="M27 33q3-3 6 0" stroke="#fde4d6" stroke-width="2.8" stroke-linecap="round" fill="none"/>
      <path class="ssl-mascot__lid ssl-mascot__lid--r" d="M39 33q3-3 6 0" stroke="#fde4d6" stroke-width="2.8" stroke-linecap="round" fill="none"/>
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
        <p class="ssl-mascot-hint" id="ssl-mascot-hint" aria-hidden="true">Hi</p>
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
  const playGreeting = () => {
    if (!fab || !motionOk() || panel?.classList.contains("is-open")) return;
    window.clearTimeout(greetTimer);
    fab.classList.remove("is-greeting");
    void fab.offsetWidth;
    fab.classList.add("is-greeting");
    mascotHint?.classList.add("is-visible");
    greetTimer = window.setTimeout(() => {
      fab.classList.remove("is-greeting");
      mascotHint?.classList.remove("is-visible");
    }, 2400);
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
