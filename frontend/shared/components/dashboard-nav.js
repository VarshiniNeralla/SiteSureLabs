/**
 * shared/components/dashboard-nav.js
 *
 * Single source of truth for the dashboard navigation bar.
 * Replaces the static <nav id="navbar"> on all three dashboard pages,
 * injects the correct active tab, and mounts the profile dropdown.
 *
 * On mobile (< 768px) the tab bar is replaced with a hamburger + drawer.
 *
 * Usage:
 *   import { mountDashboardNav } from "/shared/components/dashboard-nav.js";
 *   mountDashboardNav("live");
 *   mountDashboardNav("live", { trailingMount: true });
 */
import { mountProfileNav } from "/shared/profile-nav.js";
import { SHOW_IMAGE_ANALYSIS } from "/shared/feature-flags.js";
import { mountSmoothScroll } from "/shared/smooth-scroll.js";

const TABS = [
  { id: "live",           label: "Live Inspection", shortLabel: "Live", href: "/dashboard/live/",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>` },
  { id: "ai-analysis",    label: "AI Analysis",     shortLabel: "AI", href: "/dashboard/ai-analysis/",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 014 4v2a4 4 0 01-8 0V6a4 4 0 014-4z"/><path d="M16 14H8a4 4 0 00-4 4v2h16v-2a4 4 0 00-4-4z"/></svg>` },
  { id: "image-analysis", label: "Image Analysis",  shortLabel: "Image", href: "/dashboard/image-analysis/",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>` },
];

function visibleTabs() {
  return TABS.filter((tab) => tab.id !== "image-analysis" || SHOW_IMAGE_ANALYSIS);
}

const HAMBURGER_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="3" y1="6" x2="21" y2="6"/>
  <line x1="3" y1="12" x2="21" y2="12"/>
  <line x1="3" y1="18" x2="21" y2="18"/>
</svg>`;

const CLOSE_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
</svg>`;

const HOME_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
  <polyline points="9 22 9 12 15 12 15 22"/>
</svg>`;

/**
 * @param {"live"|"ai-analysis"|"image-analysis"} activeTab
 * @param {{ trailingMount?: boolean }} [options]
 * @returns {HTMLElement | null} Trailing slot when trailingMount is true
 */
export function mountDashboardNav(activeTab, options = {}) {
  mountSmoothScroll();
  const tabs = visibleTabs();
  const activeLabel = tabs.find((t) => t.id === activeTab)?.label || "Dashboard";
  const segmentCount = tabs.length;

  const tabsHtml = tabs.map(({ id, label, shortLabel, href }) => {
    const active = id === activeTab;
    return `<a href="${href}"
      class="dashboard-segment__tab${active ? " is-active" : ""}"
      role="tab"
      aria-selected="${active}"
      ${active ? 'aria-current="page"' : ""}
    ><span class="dashboard-segment__label dashboard-segment__label--full">${label}</span><span class="dashboard-segment__label dashboard-segment__label--short">${shortLabel || label}</span></a>`;
  }).join("");

  const drawerItemsHtml = tabs.map(({ id, label, href, icon }) => {
    const active = id === activeTab;
    return `<a href="${href}" class="drawer-nav__item${active ? " drawer-nav__item--active" : ""}"
      ${active ? 'aria-current="page"' : ""}>
      <span class="drawer-nav__icon">${icon}</span>
      ${label}
    </a>`;
  }).join("");

  const trailingHtml = options.trailingMount
    ? '<div class="dashboard-nav-trailing" id="dashboard-nav-trailing"></div>'
    : "";

  const nav = document.createElement("nav");
  nav.id = "navbar";
  nav.className = "glass-nav glass-nav--dashboard glass-nav--compact";
  nav.setAttribute("aria-label", "Primary");
  nav.innerHTML = `
    <div class="nav-container nav-container--compact">
      <div class="nav-zone nav-zone--start">
        <button type="button" class="mobile-hamburger" id="drawer-open-btn"
          aria-label="Open navigation menu" aria-expanded="false">${HAMBURGER_SVG}</button>
        <a href="/" class="logo-container logo-container--nav">
          <img src="/assets/new_logo.png" alt="" width="40" height="40"
            class="logo-img" decoding="async">
          <span class="logo-text logo-text--dashboard">SiteSureLabs</span>
        </a>
      </div>
      <div class="nav-zone nav-zone--center">
        <div class="dashboard-segment nav-dashboard-mode"
          role="tablist"
          aria-label="Choose workspace"
          style="--segment-count: ${segmentCount}">
          ${tabsHtml}
        </div>
        <span class="mobile-page-title">${activeLabel}</span>
      </div>
      <div class="nav-zone nav-zone--end nav-actions">
        ${trailingHtml}
      </div>
    </div>`;

  const existing = document.getElementById("navbar");
  if (existing) {
    existing.replaceWith(nav);
  } else {
    document.body.insertBefore(nav, document.body.firstChild);
  }

  mountProfileNav(nav.querySelector(".nav-actions"));

  /* ── Drawer ── */
  const existingDrawer = document.getElementById("nav-drawer-overlay");
  if (existingDrawer) existingDrawer.remove();

  const overlay = document.createElement("div");
  overlay.id = "nav-drawer-overlay";
  overlay.className = "drawer-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = `
    <aside class="drawer-panel" role="dialog" aria-label="Navigation menu">
      <div class="drawer-panel__header">
        <a href="/" class="logo-container logo-container--nav">
          <img src="/assets/new_logo.png" alt="" width="32" height="32"
            class="logo-img" decoding="async">
          <span class="logo-text">SiteSureLabs</span>
        </a>
        <button type="button" class="drawer-panel__close" id="drawer-close-btn" aria-label="Close menu">${CLOSE_SVG}</button>
      </div>
      <nav class="drawer-nav" aria-label="Dashboard sections">
        ${drawerItemsHtml}
      </nav>
      <div class="drawer-panel__footer">
        <a href="/" class="drawer-nav__item drawer-nav__item--home">
          <span class="drawer-nav__icon">${HOME_SVG}</span>
          Home
        </a>
      </div>
    </aside>`;

  document.body.appendChild(overlay);

  const openBtn  = document.getElementById("drawer-open-btn");
  const closeBtn = document.getElementById("drawer-close-btn");
  let isOpen = false;

  function openDrawer() {
    isOpen = true;
    overlay.classList.add("drawer-overlay--open");
    overlay.setAttribute("aria-hidden", "false");
    openBtn.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    closeBtn.focus();
  }

  function closeDrawer() {
    isOpen = false;
    overlay.classList.remove("drawer-overlay--open");
    overlay.setAttribute("aria-hidden", "true");
    openBtn.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }

  openBtn.addEventListener("click", openDrawer);
  closeBtn.addEventListener("click", closeDrawer);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDrawer();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closeDrawer();
  });

  /* ── Mobile bottom tab bar (primary navigation on phones) ──
     Replaces the hamburger drawer for tool-switching on ≤767px.
     The drawer button is kept because the AI chat page relocates it
     into its own topbar as the conversation-history toggle. */
  mountDashboardTabbar(tabs, activeTab);

  return options.trailingMount ? document.getElementById("dashboard-nav-trailing") : null;
}

const TYPING_SELECTOR =
  "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]), textarea, [contenteditable=''], [contenteditable=true]";

function mountDashboardTabbar(tabs, activeTab) {
  document.getElementById("dashboard-tabbar")?.remove();

  const tabbar = document.createElement("nav");
  tabbar.id = "dashboard-tabbar";
  tabbar.className = "dashboard-tabbar";
  tabbar.setAttribute("role", "tablist");
  tabbar.setAttribute("aria-label", "Primary");
  tabbar.innerHTML = tabs
    .map(({ id, label, shortLabel, href, icon }) => {
      const active = id === activeTab;
      return `<a href="${href}" class="dashboard-tabbar__item${active ? " is-active" : ""}"
        role="tab" aria-selected="${active}" ${active ? 'aria-current="page"' : ""} aria-label="${label}">
        <span class="dashboard-tabbar__icon">${icon}</span>
        <span class="dashboard-tabbar__label">${shortLabel || label}</span>
      </a>`;
    })
    .join("");
  document.body.appendChild(tabbar);

  /* Hide the bar while a text field is focused so it never fights the
     on-screen keyboard or the chat composer. Defer the hide-removal so
     focus moving between fields does not flicker the bar. */
  if (!document.body.dataset.tabbarKbdBound) {
    document.body.dataset.tabbarKbdBound = "1";
    const isTyping = (el) => !!(el && el.matches && el.matches(TYPING_SELECTOR));
    document.addEventListener("focusin", (e) => {
      if (isTyping(e.target)) document.body.classList.add("kbd-open");
    });
    document.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!isTyping(document.activeElement)) document.body.classList.remove("kbd-open");
      }, 60);
    });
  }
}
