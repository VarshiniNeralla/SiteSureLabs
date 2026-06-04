import Lenis from "lenis";
import "lenis/dist/lenis.css";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DEFAULT_REVEAL_SELECTOR = [
  "[data-scroll-reveal]",
  ".reveal-on-scroll",
  ".benefit-card--reveal",
  ".m-stepper__step--reveal",
].join(",");

const PREVENT_SCROLL_SELECTOR = [
  "[data-lenis-prevent]",
  "[data-lenis-prevent-wheel]",
  "[data-lenis-prevent-touch]",
  ".drawer-overlay",
  ".modal",
  ".login-overlay",
  ".cht-messages",
  ".cht-sidebar__nav",
  ".ssl-assistant-panel",
  ".ssl-assistant-messages",
  "#recent-section",
  "#uploads-grid",
].join(",");

let providerInstance = null;

function prefersReducedMotion() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getNavOffset() {
  const nav = document.getElementById("navbar") || document.querySelector(".admin-nav");
  return nav ? Math.ceil(nav.getBoundingClientRect().height + 12) : 72;
}

function getScrollInputMode() {
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const mobileWidth = window.matchMedia("(max-width: 768px)").matches;
  return coarsePointer || mobileWidth ? "touch" : "desktop";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class SmoothScrollProvider {
  constructor(options = {}) {
    this.options = options;
    this.lenis = null;
    this.rafId = 0;
    this.scrollY = window.scrollY || 0;
    this.lastScrollY = this.scrollY;
    this.scrollDirection = "up";
    this.progressBar = null;
    this.revealObserver = null;
    this.revealItems = [];
    this.parallaxItems = [];
    this.scrollTicking = false;
    this.resizeTicking = false;
    this.isReducedMotion = prefersReducedMotion();
    this.reducedMotionMql = window.matchMedia(REDUCED_MOTION_QUERY);
    this.inputMode = getScrollInputMode();

    this.handleRaf = this.handleRaf.bind(this);
    this.handleNativeScroll = this.handleNativeScroll.bind(this);
    this.handleLenisScroll = this.handleLenisScroll.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleReducedMotionChange = this.handleReducedMotionChange.bind(this);
    this.handlePageShow = this.handlePageShow.bind(this);
    this.handlePageHide = this.handlePageHide.bind(this);
    this.handleAnchorClick = this.handleAnchorClick.bind(this);
  }

  mount() {
    document.documentElement.classList.add("smooth-scroll-ready");
    this.setupProgressBar();
    this.setupRevealAnimations();
    this.setupParallax();
    this.bindGlobalEvents();
    this.applyMotionMode();
    return this;
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener("scroll", this.handleNativeScroll);
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("pageshow", this.handlePageShow);
    window.removeEventListener("pagehide", this.handlePageHide);
    document.removeEventListener("click", this.handleAnchorClick);
    this.reducedMotionMql.removeEventListener("change", this.handleReducedMotionChange);
    this.revealObserver?.disconnect();
    this.revealObserver = null;
    this.lenis?.destroy();
    this.lenis = null;
    this.progressBar?.remove();
    this.progressBar = null;
    document.documentElement.classList.remove(
      "smooth-scroll-ready",
      "smooth-scroll-reduced-motion",
      "lenis-smooth"
    );
  }

  bindGlobalEvents() {
    window.addEventListener("scroll", this.handleNativeScroll, { passive: true });
    window.addEventListener("resize", this.handleResize, { passive: true });
    window.addEventListener("pageshow", this.handlePageShow);
    window.addEventListener("pagehide", this.handlePageHide);
    document.addEventListener("click", this.handleAnchorClick);
    this.reducedMotionMql.addEventListener("change", this.handleReducedMotionChange);
  }

  applyMotionMode() {
    this.isReducedMotion = prefersReducedMotion();
    document.documentElement.classList.toggle(
      "smooth-scroll-reduced-motion",
      this.isReducedMotion
    );

    if (this.isReducedMotion) {
      this.destroyLenis();
      this.revealItems.forEach((item) => item.classList.add("is-visible"));
      this.parallaxItems.forEach(({ el }) => {
        el.style.transform = "";
      });
      this.updateChrome();
      return;
    }

    this.createLenis();
    this.updateChrome();
    this.updateParallax();
  }

  createLenis() {
    if (this.lenis) return;
    this.inputMode = getScrollInputMode();
    const isTouchInput = this.inputMode === "touch";

    this.lenis = new Lenis({
      lerp: isTouchInput ? 0.12 : 0.085,
      wheelMultiplier: isTouchInput ? 0.95 : 0.9,
      touchMultiplier: isTouchInput ? 0.9 : 1,
      smoothWheel: true,
      syncTouch: !isTouchInput,
      syncTouchLerp: isTouchInput ? 0.12 : 0.08,
      touchInertiaExponent: isTouchInput ? 1.25 : 1.45,
      anchors: {
        offset: -getNavOffset(),
        lerp: isTouchInput ? 0.12 : 0.1,
      },
      prevent: (node) => Boolean(node?.closest?.(PREVENT_SCROLL_SELECTOR)),
      stopInertiaOnNavigate: true,
    });

    this.lenis.on("scroll", this.handleLenisScroll);
    this.rafId = requestAnimationFrame(this.handleRaf);
    window.__lenis = this.lenis;
  }

  destroyLenis() {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lenis?.destroy();
    this.lenis = null;
    if (window.__lenis) window.__lenis = null;
  }

  handleRaf(time) {
    this.lenis?.raf(time);
    this.rafId = requestAnimationFrame(this.handleRaf);
  }

  handleLenisScroll(instance) {
    this.scrollY = instance.scroll || window.scrollY || 0;
    this.scrollDirection = instance.direction === 1 ? "down" : "up";
    this.requestScrollUpdate();
  }

  handleNativeScroll() {
    if (this.lenis) return;
    this.scrollY = window.scrollY || 0;
    this.scrollDirection = this.scrollY > this.lastScrollY ? "down" : "up";
    this.requestScrollUpdate();
  }

  requestScrollUpdate() {
    if (this.scrollTicking) return;
    this.scrollTicking = true;
    requestAnimationFrame(() => {
      this.scrollTicking = false;
      this.updateChrome();
      this.updateParallax();
      this.lastScrollY = this.scrollY;
    });
  }

  handleResize() {
    if (this.resizeTicking) return;
    this.resizeTicking = true;
    requestAnimationFrame(() => {
      this.resizeTicking = false;
      const nextInputMode = getScrollInputMode();
      if (this.lenis && nextInputMode !== this.inputMode) {
        this.destroyLenis();
        this.createLenis();
      }
      this.lenis?.resize();
      this.collectParallaxItems();
      this.updateChrome();
      this.updateParallax();
    });
  }

  handleReducedMotionChange() {
    this.applyMotionMode();
  }

  handlePageShow() {
    this.lenis?.start();
    this.lenis?.resize();
    this.setupRevealAnimations();
    this.setupParallax();
    this.requestScrollUpdate();
  }

  handlePageHide() {
    this.lenis?.stop();
  }

  setupProgressBar() {
    if (this.progressBar) return;
    const bar = document.createElement("div");
    bar.className = "scroll-progress";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);
    this.progressBar = bar;
  }

  updateChrome() {
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = scrollHeight > 0 ? clamp(this.scrollY / scrollHeight, 0, 1) : 0;
    this.progressBar?.style.setProperty("--scroll-progress", String(progress));

    const nav = document.getElementById("navbar") || document.querySelector(".admin-nav");
    if (!nav) return;
    const pastTop = this.scrollY > 8;
    const compact = this.scrollY > 64 && this.scrollDirection === "down";
    nav.classList.toggle("glass-nav--scrolled", pastTop);
    nav.classList.toggle("glass-nav--scroll-compact", compact);
    nav.classList.toggle("admin-nav--scrolled", pastTop);
    nav.classList.toggle("admin-nav--scroll-compact", compact);
    nav.classList.toggle("glass-nav--scroll-up", this.scrollDirection === "up" && pastTop);
  }

  setupRevealAnimations() {
    this.revealObserver?.disconnect();
    this.revealItems = Array.from(document.querySelectorAll(DEFAULT_REVEAL_SELECTOR));

    if (this.isReducedMotion || !("IntersectionObserver" in window)) {
      this.revealItems.forEach((item) => item.classList.add("is-visible"));
      return;
    }

    this.revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          this.revealObserver?.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -10% 0px" }
    );

    this.revealItems.forEach((item) => this.revealObserver.observe(item));
  }

  setupParallax() {
    this.collectParallaxItems();
    this.updateParallax();
  }

  collectParallaxItems() {
    const autoItems = [
      ...document.querySelectorAll(".hero-decor-layer, .hero-spatial-canvas"),
    ];
    const explicitItems = Array.from(document.querySelectorAll("[data-scroll-parallax]"));
    const items = [...new Set([...autoItems, ...explicitItems])];

    this.parallaxItems = items.map((el) => {
      const raw = Number(el.getAttribute("data-scroll-parallax"));
      const strength = Number.isFinite(raw) ? raw : 0.06;
      return { el, strength: clamp(strength, -0.1, 0.1) };
    });
  }

  updateParallax() {
    if (this.isReducedMotion || !this.parallaxItems.length) return;
    const viewportCenter = window.innerHeight / 2;
    this.parallaxItems.forEach(({ el, strength }) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -120 || rect.top > window.innerHeight + 120) return;
      const elementCenter = rect.top + rect.height / 2;
      const y = (viewportCenter - elementCenter) * strength;
      el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    });
  }

  handleAnchorClick(event) {
    const link = event.target?.closest?.('a[href^="#"], a[href^="/#"]');
    if (!link) return;
    const href = link.getAttribute("href");
    const hash = href?.startsWith("/#") ? href.slice(1) : href;
    if (!hash || hash === "#") return;
    const target = document.querySelector(hash);
    if (!target) return;

    event.preventDefault();
    if (this.lenis && !this.isReducedMotion) {
      const lerp = getScrollInputMode() === "touch" ? 0.12 : 0.1;
      this.lenis.scrollTo(target, { offset: -getNavOffset(), lerp });
    } else {
      target.scrollIntoView({ behavior: this.isReducedMotion ? "auto" : "smooth" });
    }
    history.pushState(null, "", hash);
  }

  scrollTo(target, options = {}) {
    if (this.lenis && !this.isReducedMotion) {
      const lerp = getScrollInputMode() === "touch" ? 0.12 : 0.1;
      this.lenis.scrollTo(target, { offset: -getNavOffset(), lerp, ...options });
      return;
    }
    const behavior = this.isReducedMotion ? "auto" : "smooth";
    if (typeof target === "number") {
      // Numeric targets are absolute scroll positions. scrollIntoView only works
      // on nodes, so route these to window.scrollTo (honouring any offset).
      window.scrollTo({ top: Math.max(0, target + (options.offset || 0)), behavior });
      return;
    }
    const node = typeof target === "string" ? document.querySelector(target) : target;
    node?.scrollIntoView?.({ behavior });
  }
}

export function mountSmoothScroll(options = {}) {
  if (providerInstance) return providerInstance;
  providerInstance = new SmoothScrollProvider(options).mount();
  window.__smoothScrollProvider = providerInstance;
  return providerInstance;
}

export function getSmoothScrollProvider() {
  return providerInstance;
}
