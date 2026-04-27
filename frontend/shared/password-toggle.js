/** Eye / eye-off icons — wire to password input + toggle button */
const ICON_EYE = `<svg class="password-toggle__svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 12c1.9-3.1 5.3-5.6 9.8-5.6s7.9 2.5 9.8 5.6c-1.9 3.1-5.3 5.6-9.8 5.6S4.1 15.1 2.2 12Z"/><ellipse cx="12" cy="12" rx="2.65" ry="2.65"/></svg>`;

const ICON_EYE_OFF = `<svg class="password-toggle__svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 6.6A10.9 10.9 0 0 1 12 6.4c4.5 0 7.9 2.5 9.8 5.6a13.7 13.7 0 0 1-2.8 3.3"/><path d="M6.5 8.5A13.7 13.7 0 0 0 2.2 12c1.9 3.1 5.3 5.6 9.8 5.6 1.9 0 3.5-.5 4.9-1.4"/><path d="M9.7 9.7a3.3 3.3 0 0 0 4.6 4.6"/><path d="M4 4l16 16"/></svg>`;

/**
 * @param {HTMLInputElement | null} input
 * @param {HTMLButtonElement | null} toggle
 */
export function wirePasswordToggle(input, toggle) {
  if (!input || !toggle) return;

  const sync = () => {
    const visible = input.type === "text";
    toggle.innerHTML = visible ? ICON_EYE_OFF : ICON_EYE;
    toggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    toggle.setAttribute("aria-pressed", visible ? "true" : "false");
  };

  sync();
  toggle.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    sync();
  });
}
