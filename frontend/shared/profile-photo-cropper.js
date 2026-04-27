/**
 * Circular profile photo cropper: default "contain" fit (full image visible),
 * pan, zoom in/out, JPEG export.
 */

const EXPORT_SIZE = 512;
const PREVIEW = 280;
const R = PREVIEW / 2;

/** Slider = multiplier on scaleFit; <1 zooms out slightly, >1 zooms in */
const ZOOM_SLIDER_MIN = 0.78;
const ZOOM_SLIDER_MAX = 3.75;
const ZOOM_SLIDER_DEFAULT = 1;
const ZOOM_STEP = 0.02;
const WHEEL_ZOOM_STEP = 0.055;
/** Step per click on + / − buttons */
const BUTTON_ZOOM_STEP = 0.08;

const ZOOM_OUT_ICON = `<svg class="pn-crop-zoom__svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2"/>
  <path d="M7.5 10.5h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const ZOOM_IN_ICON = `<svg class="pn-crop-zoom__svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2"/>
  <path d="M7.5 10.5h6M10.5 7.5v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/**
 * Uniform scale so the entire image fits inside PREVIEW×PREVIEW (contain).
 * @param {number} nw
 * @param {number} nh
 */
function scaleToFitContain(nw, nh) {
  return Math.min(PREVIEW / nw, PREVIEW / nh);
}

/**
 * @param {Object} opts
 * @param {File} opts.file
 * @param {() => void} [opts.onCancel]
 * @param {(blob: Blob) => void} opts.onConfirm
 */
export function openPhotoCropper({ file, onCancel, onConfirm }) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.crossOrigin = "anonymous";

  const backdrop = document.createElement("div");
  backdrop.className = "pn-crop-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Adjust profile photo");

  backdrop.innerHTML = `
    <div class="pn-crop-card">
      <div class="pn-crop-card__head">
        <h2 class="pn-crop-card__title">Adjust photo</h2>
        <p class="pn-crop-card__sub">Drag to reposition. Fine-tune zoom below or use your trackpad.</p>
      </div>
      <div class="pn-crop-viewport" id="pn-crop-viewport">
        <canvas id="pn-crop-canvas" width="${PREVIEW}" height="${PREVIEW}" aria-hidden="true"></canvas>
        <div class="pn-crop-ring" aria-hidden="true"></div>
      </div>
      <div class="pn-crop-zoom-wrap">
        <div class="pn-crop-zoom-rail" aria-label="Zoom controls">
          <button type="button" class="pn-crop-zoom__cap" id="pn-crop-zoom-out" aria-label="Zoom out">
            ${ZOOM_OUT_ICON}
          </button>
          <div class="pn-crop-zoom-track">
            <div class="pn-crop-zoom-track__bg" aria-hidden="true"></div>
            <div class="pn-crop-zoom-fill" id="pn-crop-zoom-fill"></div>
            <input type="range" class="pn-crop-zoom__range" id="pn-crop-zoom"
              min="${ZOOM_SLIDER_MIN}" max="${ZOOM_SLIDER_MAX}" step="${ZOOM_STEP}"
              value="${ZOOM_SLIDER_DEFAULT}" aria-valuemin="${ZOOM_SLIDER_MIN}" aria-valuemax="${ZOOM_SLIDER_MAX}"
              aria-valuenow="${ZOOM_SLIDER_DEFAULT}" aria-label="Zoom level">
          </div>
          <button type="button" class="pn-crop-zoom__cap" id="pn-crop-zoom-in" aria-label="Zoom in">
            ${ZOOM_IN_ICON}
          </button>
        </div>
        <div class="pn-crop-zoom-meta">
          <span class="pn-crop-zoom__readout" id="pn-crop-zoom-readout">100%</span>
          <span class="pn-crop-zoom__hint">magnification</span>
        </div>
      </div>
      <div class="pn-crop-actions">
        <button type="button" class="pn-crop-btn pn-crop-btn--ghost" id="pn-crop-cancel">Cancel</button>
        <button type="button" class="pn-crop-btn pn-crop-btn--primary" id="pn-crop-save">Save</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const canvas = backdrop.querySelector("#pn-crop-canvas");
  const ctx = canvas.getContext("2d");
  const viewport = backdrop.querySelector("#pn-crop-viewport");
  const zoomEl = backdrop.querySelector("#pn-crop-zoom");
  const zoomFillEl = backdrop.querySelector("#pn-crop-zoom-fill");
  const zoomReadoutEl = backdrop.querySelector("#pn-crop-zoom-readout");

  let nw = 1;
  let nh = 1;
  /** Contain scale: entire image in preview square at zoom 1 */
  let scaleFit = 1;
  /** Multiplier on scaleFit (slider value) */
  let zoomMul = ZOOM_SLIDER_DEFAULT;
  /** Pan offset in canvas px from centered position */
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function displayScale() {
    return scaleFit * zoomMul;
  }

  function syncZoomChrome() {
    const span = ZOOM_SLIDER_MAX - ZOOM_SLIDER_MIN;
    const t = span > 0 ? (zoomMul - ZOOM_SLIDER_MIN) / span : 0;
    zoomFillEl.style.width = `${Math.min(100, Math.max(0, t * 100))}%`;
    zoomReadoutEl.textContent = `${Math.round(zoomMul * 100)}%`;
    zoomEl.setAttribute("aria-valuenow", String(Math.round(zoomMul * 1000) / 1000));
  }

  function layoutDraw() {
    const s = displayScale();
    const dw = nw * s;
    const dh = nh * s;
    return { s, dw, dh };
  }

  function clampPan(dw, dh) {
    if (dw >= PREVIEW) {
      const minP = (PREVIEW - dw) / 2;
      const maxP = (dw - PREVIEW) / 2;
      panX = Math.min(maxP, Math.max(minP, panX));
    } else {
      panX = 0;
    }
    if (dh >= PREVIEW) {
      const minP = (PREVIEW - dh) / 2;
      const maxP = (dh - PREVIEW) / 2;
      panY = Math.min(maxP, Math.max(minP, panY));
    } else {
      panY = 0;
    }
  }

  function draw() {
    const { dw, dh } = layoutDraw();
    clampPan(dw, dh);
    const { dw: dw2, dh: dh2 } = layoutDraw();
    const x = (PREVIEW - dw2) / 2 + panX;
    const y = (PREVIEW - dh2) / 2 + panY;

    ctx.clearRect(0, 0, PREVIEW, PREVIEW);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, PREVIEW, PREVIEW);
    ctx.drawImage(img, 0, 0, nw, nh, x, y, dw2, dh2);
    ctx.restore();
  }

  function exportBlob() {
    const { dw, dh } = layoutDraw();
    clampPan(dw, dh);
    const { dw: dw2, dh: dh2 } = layoutDraw();
    const x = (PREVIEW - dw2) / 2 + panX;
    const y = (PREVIEW - dh2) / 2 + panY;

    const k = EXPORT_SIZE / PREVIEW;
    const dwE = dw2 * k;
    const dhE = dh2 * k;
    const xE = (EXPORT_SIZE - dwE) / 2 + panX * k;
    const yE = (EXPORT_SIZE - dhE) / 2 + panY * k;

    const out = document.createElement("canvas");
    out.width = EXPORT_SIZE;
    out.height = EXPORT_SIZE;
    const octx = out.getContext("2d");
    const OR = EXPORT_SIZE / 2;
    octx.beginPath();
    octx.arc(OR, OR, OR - 1, 0, Math.PI * 2);
    octx.clip();
    octx.fillStyle = "#0f172a";
    octx.fillRect(0, 0, EXPORT_SIZE, EXPORT_SIZE);
    octx.drawImage(img, 0, 0, nw, nh, xE, yE, dwE, dhE);

    return new Promise((resolve) => {
      out.toBlob((blob) => resolve(blob || new Blob()), "image/jpeg", 0.92);
    });
  }

  function onPointerDown(e) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    panX += dx;
    panY += dy;
    draw();
  }

  function onPointerUp(e) {
    dragging = false;
    try {
      viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
    zoomMul = Math.min(ZOOM_SLIDER_MAX, Math.max(ZOOM_SLIDER_MIN, zoomMul + delta));
    zoomMul = Math.round(zoomMul / ZOOM_STEP) * ZOOM_STEP;
    zoomEl.value = String(zoomMul);
    draw();
    syncZoomChrome();
  }

  function cleanup() {
    URL.revokeObjectURL(url);
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      onCancel?.();
    }
  }

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerUp);
  viewport.addEventListener("wheel", onWheel, { passive: false });

  function applyZoom(delta) {
    zoomMul = Math.min(
      ZOOM_SLIDER_MAX,
      Math.max(ZOOM_SLIDER_MIN, zoomMul + delta),
    );
    zoomMul = Math.round(zoomMul / ZOOM_STEP) * ZOOM_STEP;
    zoomEl.value = String(zoomMul);
    draw();
    syncZoomChrome();
  }

  zoomEl.addEventListener("input", () => {
    zoomMul = Math.min(ZOOM_SLIDER_MAX, Math.max(ZOOM_SLIDER_MIN, parseFloat(zoomEl.value, 10) || ZOOM_SLIDER_DEFAULT));
    draw();
    syncZoomChrome();
  });

  backdrop.querySelector("#pn-crop-zoom-out").addEventListener("click", (e) => {
    e.preventDefault();
    applyZoom(-BUTTON_ZOOM_STEP);
  });
  backdrop.querySelector("#pn-crop-zoom-in").addEventListener("click", (e) => {
    e.preventDefault();
    applyZoom(BUTTON_ZOOM_STEP);
  });

  syncZoomChrome();

  backdrop.querySelector("#pn-crop-cancel").addEventListener("click", () => {
    cleanup();
    onCancel?.();
  });

  backdrop.querySelector("#pn-crop-save").addEventListener("click", async () => {
    const blob = await exportBlob();
    cleanup();
    onConfirm(blob);
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      cleanup();
      onCancel?.();
    }
  });

  document.addEventListener("keydown", onKey);

  requestAnimationFrame(() => {
    void backdrop.offsetHeight;
    backdrop.classList.add("pn-crop-backdrop--visible");
  });

  img.onload = () => {
    nw = img.naturalWidth || 1;
    nh = img.naturalHeight || 1;
    scaleFit = scaleToFitContain(nw, nh);
    zoomMul = ZOOM_SLIDER_DEFAULT;
    panX = 0;
    panY = 0;
    zoomEl.value = String(ZOOM_SLIDER_DEFAULT);
    draw();
    syncZoomChrome();
  };

  img.onerror = () => {
    cleanup();
    onCancel?.();
  };

  img.src = url;
}

export function isPhotoCropperOpen() {
  return Boolean(document.querySelector(".pn-crop-backdrop"));
}
