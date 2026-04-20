/**
 * SiteSureLabs — premium floating landing assistant.
 * Streams from POST /api/assistant/landing/stream (Gemma via backend vLLM).
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
  return `${apiBase()}/api/assistant/landing/stream`;
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

const WELCOME_HTML = `
<div class="ssl-assistant-row ssl-assistant-row--assistant" data-welcome="1">
  <div class="ssl-assistant-bubble ssl-assistant-bubble--assistant">
    <p>Hi — I'm your <strong>AI Assistant</strong>. I can explain what SiteSureLabs does, how defect detection fits your workflow, and how to use our tools.</p>
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
      <button type="button" class="ass-ctl ssl-assistant-launcher" id="ssl-assistant-launcher" aria-label="Open AI Assistant chat" aria-expanded="false" aria-controls="ssl-assistant-panel">
        <span class="ssl-assistant-launcher__ripple" aria-hidden="true"></span>
        <svg class="ssl-assistant-launcher__glyph" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 6a2 2 0 012-2h10a2 2 0 012 2v7a2 2 0 01-2 2h-3.5l-3.5 3v-3H7a2 2 0 01-2-2V6z" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round"/>
        </svg>
        <span class="ssl-assistant-launcher__label">AI Assistant</span>
      </button>

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
            <textarea id="ssl-assistant-input" class="ssl-assistant-input" rows="1" placeholder="Ask about defect detection…" autocomplete="off"></textarea>
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

  const launcher = root.querySelector("#ssl-assistant-launcher");
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

  const openPanel = () => {
    if (!panel || !launcher) return;
    hideError();
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

  minimizeBtn?.addEventListener("click", () => closePanel());

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
