import {
  getToken,
  getUser,
  saveAuth,
  clearAuth,
  clearAdminLoginSession,
} from "/shared/auth.js";
import { SHOW_IMAGE_ANALYSIS } from "/shared/feature-flags.js";
import { getSmoothScrollProvider, mountSmoothScroll } from "/shared/smooth-scroll.js";

function applyImageAnalysisVisibility() {
  if (SHOW_IMAGE_ANALYSIS) return;
  document.querySelectorAll('[data-feature="image-analysis"]').forEach((el) => {
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
  });
}

function initAdminTipMarquee() {
  const track = document.getElementById("admin-tip-track");
  const viewport = track?.closest(".admin-tip-cards");
  if (!track || !viewport || track.dataset.marqueeReady === "true") return;

  const cards = Array.from(track.children).filter((el) => el.classList.contains("admin-tip-card"));
  if (!cards.length) return;

  cards.forEach((card) => {
    const clone = card.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    clone.querySelectorAll("a, button").forEach((el) => {
      el.setAttribute("tabindex", "-1");
    });
    track.appendChild(clone);
  });

  track.dataset.marqueeReady = "true";
  viewport.classList.add("is-ready");
}
let _profileNavModulePromise = null;
let _assistantModulePromise = null;
let _formatApiDetailPromise = null;
let _passwordTogglePromise = null;

function loadProfileNavModule() {
  if (!_profileNavModulePromise) _profileNavModulePromise = import("/shared/profile-nav.js");
  return _profileNavModulePromise;
}

function loadAssistantModule() {
  if (!_assistantModulePromise) _assistantModulePromise = import("./assistant-widget.js");
  return _assistantModulePromise;
}

function loadFormatApiDetail() {
  if (!_formatApiDetailPromise) _formatApiDetailPromise = import("/shared/format-api-detail.js");
  return _formatApiDetailPromise;
}

function loadPasswordToggle() {
  if (!_passwordTogglePromise) _passwordTogglePromise = import("/shared/password-toggle.js");
  return _passwordTogglePromise;
}

function ensureAssistantStylesheet() {
  if (document.getElementById("assistant-widget-style")) return;
  const link = document.createElement("link");
  link.id = "assistant-widget-style";
  link.rel = "stylesheet";
  link.href = "assistant-widget.css";
  document.head.appendChild(link);
}

function runWhenIdle(fn) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => fn(), { timeout: 1200 });
  } else {
    window.setTimeout(fn, 180);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  mountSmoothScroll();
  applyImageAnalysisVisibility();
  initAdminTipMarquee();

  /* ═══ AUTH GATE ═══ */
  const overlay       = document.getElementById("login-overlay");
  const loginForm     = document.getElementById("login-form");
  const loginAlert    = document.getElementById("login-alert");
  const loginSubmit   = document.getElementById("login-submit");
  const loginAsAdminBtn = document.getElementById("login-as-admin");
  const navUserPill   = document.getElementById("nav-user-pill");

  function showAlert(msg, type) {
    if (!loginAlert) return;
    loginAlert.textContent = msg;
    loginAlert.className = `alert alert-${type} show`;
  }

  function applyAdminLandingLayout(user) {
    const isAdmin = user?.role === "admin";
    document.documentElement.classList.toggle("landing-admin", isAdmin);
    document.body.classList.toggle("landing-page--admin", isAdmin);
    document.documentElement.classList.toggle("landing-admin-report", isAdmin);
    document.body.classList.toggle("landing-page--admin-report", isAdmin);
    const dashboardCta = document.getElementById("nav-cta");
    const reportCta = document.getElementById("hero-generate-report-cta");
    if (dashboardCta) dashboardCta.textContent = isAdmin ? "Go to Dashboard" : "Get Started";
    if (reportCta) {
      reportCta.hidden = !isAdmin;
      reportCta.setAttribute("aria-hidden", isAdmin ? "false" : "true");
    }
  }

  function showLogin() {
    // Remove the pre-paint "authed" class so the overlay CSS is re-enabled
    // (critical when page is restored from bfcache after logout).
    document.documentElement.classList.remove("authed");
    applyAdminLandingLayout(null);
    document.getElementById("ssl-assistant-root")?.remove();
    overlay?.classList.remove("is-hidden");
    if (navUserPill) {
      // Remove the dynamically mounted profile widget
      navUserPill.querySelector(".pn-landing-wrapper")?.remove();
      navUserPill.style.display = "none";
    }
  }

  function showSite(user) {
    applyAdminLandingLayout(user);
    overlay?.classList.add("is-hidden");
    if (navUserPill) {
      navUserPill.style.display = "flex";
      runWhenIdle(async () => {
        const { mountLandingProfile } = await loadProfileNavModule();
        mountLandingProfile(navUserPill, user, {
          onLogout: () => { clearAuth(); showLogin(); },
        });
      });
    }
    if (!document.getElementById("ssl-assistant-root")) {
      runWhenIdle(async () => {
        ensureAssistantStylesheet();
        const { mountLandingAssistant } = await loadAssistantModule();
        mountLandingAssistant();
      });
    }
  }

  async function validateAndApply() {
    const token = getToken();
    const user = getUser();

    // No local session → show login immediately, nothing to validate
    if (!token || !user) { showLogin(); return; }

    // Token exists → show the site right away (no flash) and validate silently
    // in the background. Only force login if the server actively rejects the token.
    showSite(user);
    try {
      const res = await fetch("/api/defects/my", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { clearAuth(); showLogin(); }
      // res.ok → session confirmed, user already sees the site — nothing else to do
    } catch {
      // Network error — keep the user on the site; don't log them out for a blip
    }
  }

  async function doLogin(email, password) {
    loginSubmit.disabled = true;
    loginSubmit.textContent = "Signing in…";
    loginAlert.className = "alert";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        const { formatApiDetail } = await loadFormatApiDetail();
        showAlert(formatApiDetail(data) || "Login failed", "error");
        return;
      }
      clearAdminLoginSession();
      saveAuth(data.access_token, {
        user_id: data.user_id,
        email: data.email,
        role: data.role,
        name: data.name || null,
        profile_photo: data.profile_photo || null,
      });
      showSite({ email: data.email, role: data.role });
    } catch { showAlert("Network error — is the server running?", "error"); }
    finally { loginSubmit.disabled = false; loginSubmit.textContent = "Sign In"; }
  }

  loginForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    if (!email || !password) return;
    doLogin(email, password);
  });

  loginAsAdminBtn?.addEventListener("click", () => {
    window.location.href = "/admin/login/";
  });

  validateAndApply();

  // Re-run auth check when the browser restores this page from bfcache
  // (e.g. user logs out on a dashboard page and navigates back to "/").
  // DOMContentLoaded does NOT fire on bfcache restoration — pageshow does.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    validateAndApply();
  });

  runWhenIdle(async () => {
    const { wirePasswordToggle } = await loadPasswordToggle();
    wirePasswordToggle(
      document.getElementById("login-password"),
      document.getElementById("login-password-toggle")
    );
  });

  /* ═══ LANDING LOGIC — Antigravity-style fixed layout + clip reveal ═══ */
  const HERO_LINE1 = "AI-Powered";
  const HERO_LINE2 = "Construction Inspection";
  const HERO_MS_PER_CHAR = 62;
  const HERO_LINE_PAUSE_MS = 320;
  const HERO_AFTER_TYPE_MS = 500;
  const HERO_MIN_LINE_MS = 460;
  const HERO_TYPEWRITER_SEEN_KEY = "defectraHeroTypewriterSeen";
  const HERO_INTRO_DELAY_MS = 400;
  const HERO_CURSOR_LEAD_BLINKS = 1;
  const HERO_CURSOR_BLINK_MS = 400;

  const heroTypewriterDelay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function isPageReload() {
    const entry = performance.getEntriesByType("navigation")[0];
    return entry?.type === "reload";
  }

  function hasSeenHeroTypewriter() {
    try {
      return sessionStorage.getItem(HERO_TYPEWRITER_SEEN_KEY) === "1";
    } catch {
      return false;
    }
  }

  function shouldSkipHeroAnimation() {
    return hasSeenHeroTypewriter() && !isPageReload();
  }

  function markHeroTypewriterSeen() {
    try {
      sessionStorage.setItem(HERO_TYPEWRITER_SEEN_KEY, "1");
    } catch {
      /* private mode / quota */
    }
  }

  function getHeroIntroRoot() {
    return document.querySelector(".hero-section--landing");
  }

  function prepareHeroIntroHidden() {
    const root = getHeroIntroRoot();
    root?.classList.remove("is-hero-intro-ready");
    const { reveal1, reveal2, cursor } = getHeroTypewriterEls();
    if (reveal1) setLineReveal(reveal1, 0, null);
    if (reveal2) setLineReveal(reveal2, 0, null);
    cursor?.classList.add("is-off");
    document.getElementById("hero-typewriter-live")?.classList.remove("is-typing");
  }

  async function waitForHeroIntroDelay() {
    await heroTypewriterDelay(HERO_INTRO_DELAY_MS);
    getHeroIntroRoot()?.classList.add("is-hero-intro-ready");
  }

  function heroEaseOutCubic(t) {
    return 1 - (1 - t) ** 3;
  }

  function getHeroTypewriterEls() {
    const live = document.getElementById("hero-typewriter-live");
    const reveal1 = document.getElementById("hero-typewriter-reveal-1");
    const reveal2 = document.getElementById("hero-typewriter-reveal-2");
    const cursor = document.getElementById("hero-typewriter-cursor");
    const line1 = document.getElementById("hero-typewriter-line-1");
    const line2 = document.getElementById("hero-typewriter-line-2");
    return { live, reveal1, reveal2, cursor, line1, line2 };
  }

  function attachHeroCursorToLine(cursorEl, lineInnerEl) {
    if (!cursorEl || !lineInnerEl) return;
    lineInnerEl.appendChild(cursorEl);
    cursorEl.classList.remove("is-off");
    cursorEl.style.left = "0%";
  }

  function waitForHeroCursorLeadBlinks(cursorEl) {
    if (!cursorEl) return Promise.resolve();

    const blinkMs = HERO_CURSOR_BLINK_MS;
    const totalMs = HERO_CURSOR_LEAD_BLINKS * blinkMs;

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cursorEl.classList.remove("is-lead-blink");
        cursorEl.style.opacity = "";
        cursorEl.removeEventListener("animationend", onAnimationEnd);
        resolve();
      };

      const onAnimationEnd = (e) => {
        if (e.target !== cursorEl) return;
        finish();
      };

      cursorEl.classList.add("is-lead-blink");
      cursorEl.style.setProperty("--hero-cursor-blink-ms", `${blinkMs}ms`);
      cursorEl.style.setProperty("--hero-cursor-lead-blinks", String(HERO_CURSOR_LEAD_BLINKS));
      cursorEl.addEventListener("animationend", onAnimationEnd);
      window.setTimeout(finish, totalMs + 40);
    });
  }

  function setLineReveal(revealEl, progress, cursorEl) {
    const clamped = Math.max(0, Math.min(1, progress));
    revealEl.style.setProperty("--hero-reveal", String(clamped));
    if (cursorEl) {
      cursorEl.style.left = `${clamped * 100}%`;
    }
  }

  function animateLineClipReveal(revealEl, text, cursorEl) {
    const charCount = String(text || "").length;
    if (!charCount) return Promise.resolve();

    const duration = Math.max(charCount * HERO_MS_PER_CHAR, HERO_MIN_LINE_MS);
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration);
        setLineReveal(revealEl, heroEaseOutCubic(t), cursorEl);
        if (t < 1) requestAnimationFrame(tick);
        else {
          setLineReveal(revealEl, 1, cursorEl);
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  function finishHeroTypewriter({ reveal1, reveal2, cursor, ctaWrap, instant = false }) {
    setLineReveal(reveal1, 1);
    setLineReveal(reveal2, 1);
    cursor?.classList.add("is-off");
    const live = document.getElementById("hero-typewriter-live");
    live?.classList.remove("is-typing");
    if (instant) live?.classList.add("hero-typewriter-live--complete");
    if (ctaWrap) {
      ctaWrap.classList.remove("hero-primary-cta--typewriter-wait");
      ctaWrap.classList.add("hero-primary-cta--typewriter-revealed");
      if (instant) ctaWrap.classList.add("hero-primary-cta--no-motion");
    }
    document.querySelector(".hero-viewport")?.classList.add("is-revealed");
  }

  function showHeroTypewriterInstant() {
    const { reveal1, reveal2, cursor } = getHeroTypewriterEls();
    const ctaWrap = document.getElementById("hero-primary-cta-wrap");
    if (!reveal1 || !reveal2) return;
    finishHeroTypewriter({ reveal1, reveal2, cursor, ctaWrap, instant: true });
  }

  async function runLandingHeroTypewriter() {
    const { live, reveal1, reveal2, cursor, line1, line2 } = getHeroTypewriterEls();
    const ctaWrap = document.getElementById("hero-primary-cta-wrap");
    const line1Inner = line1?.querySelector(".hero-typewriter-line__inner");
    if (!live || !reveal1 || !reveal2 || !cursor || !line1Inner) return;

    prepareHeroIntroHidden();
    await waitForHeroIntroDelay();

    if (shouldSkipHeroAnimation()) {
      showHeroTypewriterInstant();
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      showHeroTypewriterInstant();
      markHeroTypewriterSeen();
      return;
    }

    live.classList.add("is-typing");
    attachHeroCursorToLine(cursor, line1Inner);
    setLineReveal(reveal1, 0, cursor);
    setLineReveal(reveal2, 0, null);
    cursor.classList.remove("is-off");
    await waitForHeroCursorLeadBlinks(cursor);

    await animateLineClipReveal(reveal1, HERO_LINE1, cursor);
    await heroTypewriterDelay(HERO_LINE_PAUSE_MS);

    const line2Inner = line2?.querySelector(".hero-typewriter-line__inner");
    attachHeroCursorToLine(cursor, line2Inner);
    await animateLineClipReveal(reveal2, HERO_LINE2, cursor);

    await heroTypewriterDelay(HERO_AFTER_TYPE_MS);
    finishHeroTypewriter({ reveal1, reveal2, cursor, ctaWrap });
    markHeroTypewriterSeen();
  }

  void runLandingHeroTypewriter();

  window.addEventListener("pageshow", (e) => {
    if (!e.persisted || !shouldSkipHeroAnimation()) return;
    void (async () => {
      prepareHeroIntroHidden();
      await waitForHeroIntroDelay();
      showHeroTypewriterInstant();
    })();
  });

  function scrollToFeatureSelector() {
    const section = document.getElementById("features");
    if (!section) return;
    const isMobileNav = window.matchMedia("(max-width: 820px)").matches;
    const el = isMobileNav ? section.querySelector(":scope > .container") || section : section;
    const provider = getSmoothScrollProvider();

    if (isMobileNav) {
      // This section is a direct CTA target on mobile. Force it to be measurable
      // before scrolling; otherwise content-visibility:auto can leave Lenis with
      // the section's intrinsic placeholder position and land too high.
      section.style.contentVisibility = "visible";
      section.style.containIntrinsicSize = "auto";
      // The sticky navbar auto-hides while scrolling down (see the nav-hidden
      // handler below), so we must NOT reserve its height here — doing so left a
      // tall band of empty space above the section once the bar slid away. Land
      // the section just under the top with a small, responsive breathing gap.
      const breathingGap = Math.min(24, Math.max(16, Math.round(window.innerWidth * 0.045)));
      const targetY = Math.max(0, window.scrollY + el.getBoundingClientRect().top - breathingGap);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (provider) {
        // targetY already encodes the final position; pass offset:0 so the
        // provider's default nav offset isn't subtracted a second time.
        provider.scrollTo(targetY, { lerp: 0.12, offset: 0 });
      } else {
        window.scrollTo({ top: targetY, behavior: reduceMotion ? "auto" : "smooth" });
      }
      return;
    }

    if (provider) {
      provider.scrollTo(el);
      return;
    }
    el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  const scrollToFeatures = () => {
    scrollToFeatureSelector();
  };
  document.getElementById("nav-cta")?.addEventListener("click", () => {
    if (getUser()?.role === "admin") {
      window.location.href = "/admin/";
      return;
    }
    scrollToFeatures();
  });
  document.getElementById("hero-generate-report-cta")?.addEventListener("click", () => {
    if (getUser()?.role !== "admin") return;
    window.location.href = "/admin/#report";
  });

  const mqNavMobile = window.matchMedia("(max-width: 820px)");
  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("primary-nav");

  const featuresDropdown = navLinks?.querySelector(".nav-dropdown");
  const featuresTrigger = featuresDropdown?.querySelector(".nav-dropdown__trigger");
  const featuresMenu = featuresDropdown?.querySelector(".nav-dropdown__menu-wrapper");
  const DESKTOP_DROPDOWN_CLOSE_DELAY_MS = 170;
  let featuresCloseTimer = null;

  const setFeaturesDropdownOpen = (open) => {
    if (!featuresDropdown || !featuresTrigger) return;
    featuresDropdown.classList.toggle("is-open", open);
    featuresTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const clearFeaturesCloseTimer = () => {
    if (featuresCloseTimer) {
      window.clearTimeout(featuresCloseTimer);
      featuresCloseTimer = null;
    }
  };

  const openFeaturesDropdown = () => {
    clearFeaturesCloseTimer();
    setFeaturesDropdownOpen(true);
  };

  const scheduleFeaturesClose = () => {
    clearFeaturesCloseTimer();
    featuresCloseTimer = window.setTimeout(() => {
      setFeaturesDropdownOpen(false);
      featuresCloseTimer = null;
    }, DESKTOP_DROPDOWN_CLOSE_DELAY_MS);
  };

  const setNavOpen = (open) => {
    if (!navToggle || !navLinks) return;
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navLinks.classList.toggle("is-open", open);
    if (!open) setFeaturesDropdownOpen(false);
  };

  navToggle?.addEventListener("click", () => {
    const next = navToggle.getAttribute("aria-expanded") !== "true";
    setNavOpen(next);
  });

  navLinks?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => {
      if (mqNavMobile.matches) setNavOpen(false);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setFeaturesDropdownOpen(false);
      setNavOpen(false);
    }
  });

  featuresTrigger?.addEventListener("click", (e) => {
    if (!mqNavMobile.matches) return;
    e.preventDefault();
    const next = !featuresDropdown?.classList.contains("is-open");
    setFeaturesDropdownOpen(next);
  });

  // Desktop hover intent: keep menu stable while moving between trigger and panel.
  // A short close delay makes tiny pointer gaps forgiving without feeling laggy.
  featuresDropdown?.addEventListener("pointerenter", () => {
    if (mqNavMobile.matches) return;
    openFeaturesDropdown();
  });

  featuresTrigger?.addEventListener("focus", () => {
    if (mqNavMobile.matches) return;
    openFeaturesDropdown();
  });

  featuresMenu?.addEventListener("focusin", () => {
    if (mqNavMobile.matches) return;
    openFeaturesDropdown();
  });

  navLinks?.querySelectorAll(":scope > li:not(.nav-dropdown)").forEach((item) => {
    item.addEventListener("pointerenter", () => {
      if (mqNavMobile.matches) return;
      clearFeaturesCloseTimer();
      setFeaturesDropdownOpen(false);
    });
  });

  // Desktop: close when pointer fully leaves the whole navbar region.
  // This prevents sticky-open forever while still avoiding tiny trigger-gap closes.
  const navbarEl = document.getElementById("navbar");
  navbarEl?.addEventListener("pointerleave", () => {
    if (mqNavMobile.matches) return;
    scheduleFeaturesClose();
  });

  navbarEl?.addEventListener("pointerenter", () => {
    if (mqNavMobile.matches) return;
    clearFeaturesCloseTimer();
  });

  featuresMenu?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => {
      if (mqNavMobile.matches) setFeaturesDropdownOpen(false);
    });
  });

  document.addEventListener("click", (e) => {
    const nav = document.getElementById("navbar");
    if (mqNavMobile.matches) {
      if (!navLinks?.classList.contains("is-open")) return;
      if (nav && !nav.contains(e.target)) setNavOpen(false);
      return;
    }

    // Desktop outside click should dismiss dropdown.
    if (nav && !nav.contains(e.target)) {
      clearFeaturesCloseTimer();
      setFeaturesDropdownOpen(false);
    }
  });

  mqNavMobile.addEventListener("change", () => {
    clearFeaturesCloseTimer();
    if (!mqNavMobile.matches) {
      setNavOpen(false);
      setFeaturesDropdownOpen(false);
    }
  });

  // Hero scroll indicator
  const scrollHint = document.getElementById("hero-scroll-hint");
  if (scrollHint) {
    scrollHint.addEventListener("click", () => {
      scrollToFeatureSelector();
    });

    const toggleScrollHint = () => {
      scrollHint.classList.toggle("is-hidden", window.scrollY > 80);
    };

    window.addEventListener(
      "scroll",
      () => {
        toggleScrollHint();
      },
      { passive: true }
    );

    // Ensure correct state on load/refresh/back navigation.
    toggleScrollHint();
  }

  function initDeferredLandingSections() {
    // Unified workflow decision engine
    const workflowEngine = document.getElementById("workflow-engine");
    if (workflowEngine) {
    const scene = workflowEngine.querySelector(".workflow-engine__scene");
    const hotspots = workflowEngine.querySelectorAll(".workflow-engine__hotspot");
    const timeEl = document.getElementById("workflow-engine-time");

    let activeMode = "image";
    let previewMode = null;
    let cycleTimer = null;
    let scanResetTimer = null;
    let startTimer = null;

    const applyMode = (mode, withTransition = true) => {
      if (!scene) return;
      scene.classList.remove("mode-idle", "mode-image", "mode-live");
      if (withTransition) {
        scene.classList.add("is-transitioning");
        clearTimeout(scanResetTimer);
        scanResetTimer = window.setTimeout(() => {
          scene.classList.remove("is-transitioning");
        }, 700);
      }
      scene.classList.add("mode-" + mode);

      // Reset scan-fill animation when entering image mode
      if (mode === "image") {
        const fill = scene.querySelector(".wf-narrative__scan-fill");
        if (fill) {
          fill.style.animation = "none";
          fill.offsetHeight;
          fill.style.animation = "";
        }
        // Re-trigger badge sequence
        scene.querySelectorAll(".wf-narrative__badge").forEach((b) => {
          b.style.animation = "none";
          b.offsetHeight;
          b.style.animation = "";
        });
      }
    };

    const setActiveMode = (mode, withTransition = true) => {
      activeMode = mode;
      if (!previewMode) applyMode(mode, withTransition);
    };

    const updateTime = () => {
      if (!timeEl) return;
      const now = new Date();
      timeEl.textContent = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      });
    };

    const startCycle = () => {
      clearInterval(cycleTimer);
      cycleTimer = window.setInterval(() => {
        setActiveMode(activeMode === "image" ? "live" : "image", true);
      }, 7000);
    };

    applyMode("idle", false);
    updateTime();
    const timeTimer = window.setInterval(updateTime, 1000);

    // Measure SVG path lengths for precise draw-on animation
    scene.querySelectorAll(".wf-narrative__crack, .wf-narrative__crack--live").forEach((path) => {
      if (path.getTotalLength) {
        const len = Math.ceil(path.getTotalLength());
        path.style.setProperty("--seg-len", len);
      }
    });

    startTimer = window.setTimeout(() => {
      setActiveMode("image", false);
      startCycle();
    }, 1000);

    hotspots.forEach((spot) => {
      const workflow = spot.getAttribute("data-workflow");
      if (!workflow) return;

      const href = workflow === "image" ? "/dashboard/image-analysis/" : "/dashboard/live/";

      spot.addEventListener("mouseenter", () => {
        previewMode = workflow;
        applyMode(workflow, false);
      });

      spot.addEventListener("mouseleave", () => {
        previewMode = null;
        applyMode(activeMode, false);
      });

      spot.addEventListener("focus", () => {
        previewMode = workflow;
        applyMode(workflow, false);
      });

      spot.addEventListener("blur", () => {
        previewMode = null;
        applyMode(activeMode, false);
      });

      spot.addEventListener("click", () => {
        window.location.href = href;
      });
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInterval(cycleTimer);
        cycleTimer = null;
      } else if (!cycleTimer) {
        startCycle();
      }
    });

    window.addEventListener("pagehide", () => {
      clearInterval(cycleTimer);
      cycleTimer = null;
      clearInterval(timeTimer);
      clearTimeout(scanResetTimer);
      clearTimeout(startTimer);
    });
    }

    const setupReveal = (selector, threshold = 0.15) => {
    const items = document.querySelectorAll(selector);
    if (!items.length) return;
    if (!("IntersectionObserver" in window)) {
      items.forEach((item) => item.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold, rootMargin: "0px 0px -8% 0px" }
    );

    items.forEach((item) => observer.observe(item));
  };

    // Section reveal animations
    setupReveal(".m-stepper__step--reveal", 0.15);
    setupReveal(".benefit-card--reveal", 0.12);
    setupReveal(".reveal-on-scroll", 0.1);

    // ── FAQ Accordion ──
    const faqItems = document.querySelectorAll(".faq-item");

    const closeFaq = (item) => {
    const answer = item.querySelector(".faq-answer");
    if (!answer) return Promise.resolve();

    return new Promise((resolve) => {
      item.classList.remove("is-open");
      answer.style.height = answer.scrollHeight + "px";
      // Force reflow so the browser registers the starting height
      answer.offsetHeight;
      answer.style.height = "0";
      answer.style.opacity = "0";

      const onEnd = () => {
        answer.removeEventListener("transitionend", onEnd);
        item.removeAttribute("open");
        resolve();
      };
      answer.addEventListener("transitionend", onEnd);
    });
  };

    const openFaq = (item) => {
    const answer = item.querySelector(".faq-answer");
    if (!answer) return;

    item.setAttribute("open", "");
    item.classList.add("is-open");

    const targetHeight = answer.scrollHeight;
    answer.style.height = "0";
    answer.style.opacity = "0";
    // Force reflow
    answer.offsetHeight;
    answer.style.height = targetHeight + "px";
    answer.style.opacity = "1";

    const onEnd = () => {
      answer.removeEventListener("transitionend", onEnd);
      answer.style.height = "auto";
    };
    answer.addEventListener("transitionend", onEnd);
  };

    // Normalize initial accordion state — all items start collapsed.
    faqItems.forEach((item) => {
    item.removeAttribute("open");
    item.classList.remove("is-open");
    const answer = item.querySelector(".faq-answer");
    if (answer) {
      answer.style.height = "0";
      answer.style.opacity = "0";
    }
  });

    faqItems.forEach((item) => {
    const summary = item.querySelector("summary");
    if (!summary) return;

    summary.addEventListener("click", (e) => {
      e.preventDefault();

      const isOpen = item.classList.contains("is-open");

      // Close all other open items
      const closePromises = [];
      faqItems.forEach((other) => {
        if (other !== item && other.classList.contains("is-open")) {
          closePromises.push(closeFaq(other));
        }
      });

      if (isOpen) {
        // Close the clicked item
        closeFaq(item);
      } else {
        // Open the clicked item
        openFaq(item);
      }
    });
    });
  }

  // ── Smart Navbar Scroll ──
  const navbar = document.getElementById("navbar");
  if (navbar) {
    let lastScrollY = window.scrollY;
    let ticking = false;

    window.addEventListener("scroll", () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const currentScrollY = window.scrollY;
          const scrollDelta = currentScrollY - lastScrollY;
          
          // Use a threshold of 5px to prevent jitter on small scroll movements
          if (Math.abs(scrollDelta) > 5 || currentScrollY <= 0) {
            if (scrollDelta > 0 && currentScrollY > 80) {
              navbar.classList.add("nav-hidden");
            } else {
              navbar.classList.remove("nav-hidden");
            }
            lastScrollY = currentScrollY;
          }
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }

  runWhenIdle(initDeferredLandingSections);

});
