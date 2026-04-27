/**
 * shared/components/dashboard-footer.js
 *
 * Single source of truth for the dashboard footer.
 * Replaces the static <footer> on all dashboard pages.
 *
 * Usage:
 *   import { mountDashboardFooter } from "/shared/components/dashboard-footer.js";
 *   mountDashboardFooter();
 */

export function mountDashboardFooter() {
  // Avoid double-mounting
  if (document.querySelector(".site-footer--dashboard")) return;

  const footer = document.createElement("footer");
  footer.className = "site-footer site-footer--dashboard";
  footer.setAttribute("aria-label", "Site footer");
  footer.innerHTML = `
    <div class="container site-footer__bottom-inner">
      <p class="site-footer__copy">
        &copy; 2026 SiteSureLabs Construction Intelligence. All rights reserved.
      </p>
    </div>`;

  document.body.appendChild(footer);
}
