import { getToken, getUser } from "/shared/auth.js";
import { mountDashboardNav } from "/shared/components/dashboard-nav.js";
import { mountDashboardFooter } from "/shared/components/dashboard-footer.js";

document.addEventListener("DOMContentLoaded", () => {
  mountDashboardNav("live");
  mountDashboardFooter();

  const token = getToken();
  const user  = getUser();
  if (!token || !user) return;

  /* ═══════════════════════════════════════════════
     DOM refs
     ═══════════════════════════════════════════════ */
  const panels     = ["step-capture", "step-preview", "step-form", "step-success"];
  const cameraIn   = document.getElementById("camera-input");
  const imageIn    = document.getElementById("image-input");
  const previewImg = document.getElementById("preview-img");
  const formThumb  = document.getElementById("form-thumb");
  const successThumb = document.getElementById("success-thumb");
  const submitBtn  = document.getElementById("btn-submit");
  const submitText = document.getElementById("submit-text");
  const alertEl    = document.getElementById("insp-alert");
  const statusEl   = document.getElementById("capture-status");
  const tipEl      = document.getElementById("capture-tip");
  const cameraModal = document.getElementById("camera-modal");
  const cameraPreview = document.getElementById("camera-preview");
  const cameraCaptureBtn = document.getElementById("camera-capture-btn");
  const cameraCancelBtn = document.getElementById("camera-cancel-btn");
  const cameraModalCloseBtn = document.getElementById("camera-modal-close");

  const selTower = document.getElementById("sel-tower");
  const selFloor = document.getElementById("sel-floor");
  const selFlat  = document.getElementById("sel-flat");
  const selRoom  = document.getElementById("sel-room");
  const selDescription = document.getElementById("sel-description");
  const sttBtn = document.getElementById("btn-stt");
  const descHelp = document.getElementById("desc-help");

  let selectedFile = null;
  let previewUrl   = "";
  let allUploadItems = [];
  let desktopCameraStream = null;
  let recognition = null;
  let isListening = false;
  let sttBaseText = "";
  let sttFinalText = "";

  /* ═══════════════════════════════════════════════
     Rotating tips
     ═══════════════════════════════════════════════ */
  const TIPS = [
    "Capture the defect clearly for accurate AI detection",
    "Ensure proper lighting for better results",
    "Get close to the defect for a detailed view",
    "Include surrounding area for context",
    "Hold your device steady to avoid blur",
  ];
  let tipIdx = 0;
  let tipInterval;

  function showTip() {
    const svg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
    tipEl.innerHTML = `<span>${svg} ${TIPS[tipIdx]}</span>`;
    tipIdx = (tipIdx + 1) % TIPS.length;
  }

  function startTips() {
    showTip();
    tipInterval = setInterval(showTip, 5000);
  }

  function stopTips() {
    clearInterval(tipInterval);
  }

  startTips();

  /* ═══════════════════════════════════════════════
     Populate selects
     ═══════════════════════════════════════════════ */
  for (let i = 0; i <= 25; i++) {
    const o = document.createElement("option");
    o.value = i === 0 ? "Ground" : String(i);
    o.textContent = i === 0 ? "Ground" : String(i);
    selFloor.appendChild(o);
  }
  for (let i = 1; i <= 16; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = String(i);
    selFlat.appendChild(o);
  }

  /* ═══════════════════════════════════════════════
     Step state machine
     ═══════════════════════════════════════════════ */
  function goTo(stepId) {
    panels.forEach((id) => {
      document.getElementById(id).classList.remove("step-panel--active");
    });
    document.getElementById(stepId).classList.add("step-panel--active");
    alertEl.className = "insp-alert";
    updateStepBar(stepId);

    if (stepId === "step-capture") startTips();
    else stopTips();
  }

  function updateStepBar(stepId) {
    const stepMap = { "step-capture": 1, "step-preview": 2, "step-form": 3, "step-success": 3 };
    const current = stepMap[stepId] || 1;

    document.querySelectorAll(".step-bar__step").forEach((stepEl) => {
      const n = Number(stepEl.dataset.step);
      stepEl.classList.remove("step-bar__step--active", "step-bar__step--done");
      if (n < current || stepId === "step-success") stepEl.classList.add("step-bar__step--done");
      else if (n === current) stepEl.classList.add("step-bar__step--active");
    });

    document.querySelectorAll(".step-bar__dot").forEach((dot) => {
      const n = Number(dot.dataset.step);
      dot.classList.remove("step-bar__dot--active", "step-bar__dot--done");
      if (n < current) dot.classList.add("step-bar__dot--done");
      else if (n === current) dot.classList.add("step-bar__dot--active");
      if (stepId === "step-success") {
        dot.classList.remove("step-bar__dot--active");
        dot.classList.add("step-bar__dot--done");
      }
    });

    document.querySelectorAll(".step-bar__line").forEach((line) => {
      const n = Number(line.dataset.line);
      line.classList.toggle("step-bar__line--done", n < current || stepId === "step-success");
    });
  }

  /* ═══════════════════════════════════════════════
     Step 1: Capture
     ═══════════════════════════════════════════════ */
  function pickFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    selectedFile = file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    previewImg.src = previewUrl;

    statusEl.textContent = "Image ready \u2713";
    statusEl.className = "capture-status capture-status--ready";

    goTo("step-preview");
  }

  function resetStatus() {
    statusEl.textContent = "No image selected";
    statusEl.className = "capture-status capture-status--empty";
  }

  function setCaptureError(msg) {
    statusEl.textContent = msg;
    statusEl.className = "capture-status capture-status--error";
  }

  function isMobileLikeDevice() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;
  }

  async function stopDesktopCamera() {
    if (desktopCameraStream) {
      desktopCameraStream.getTracks().forEach((track) => track.stop());
      desktopCameraStream = null;
    }
    if (cameraPreview) cameraPreview.srcObject = null;
  }

  async function closeDesktopCameraModal() {
    cameraModal?.classList.remove("camera-modal--open");
    await stopDesktopCamera();
  }

  async function openDesktopCameraModal() {
    if (!cameraModal || !cameraPreview) {
      cameraIn.click();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCaptureError("No camera detected on this device.");
      return;
    }
    try {
      desktopCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      const name = err && err.name ? err.name : "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCaptureError("No camera detected on this device.");
      } else if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setCaptureError("Camera access denied. Allow permission and try again.");
      } else {
        setCaptureError("Unable to open camera. Please use Upload Image.");
      }
      return;
    }
    cameraPreview.srcObject = desktopCameraStream;
    cameraModal.classList.add("camera-modal--open");
  }

  async function captureDesktopFrame() {
    if (!cameraPreview || !desktopCameraStream) return;
    const width = cameraPreview.videoWidth || 1280;
    const height = cameraPreview.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(cameraPreview, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      setCaptureError("Could not capture image. Please try again.");
      return;
    }
    const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });
    await closeDesktopCameraModal();
    pickFile(file);
  }

  document.getElementById("btn-take-photo").addEventListener("click", () => {
    if (isMobileLikeDevice()) {
      cameraIn.click();
      return;
    }
    openDesktopCameraModal();
  });
  document.getElementById("btn-upload-image").addEventListener("click", () => imageIn.click());

  cameraCaptureBtn?.addEventListener("click", captureDesktopFrame);
  cameraCancelBtn?.addEventListener("click", closeDesktopCameraModal);
  cameraModalCloseBtn?.addEventListener("click", closeDesktopCameraModal);
  cameraModal?.addEventListener("click", (e) => {
    if (e.target === cameraModal) closeDesktopCameraModal();
  });

  cameraIn.addEventListener("change", () => pickFile(cameraIn.files[0]));
  imageIn.addEventListener("change", () => pickFile(imageIn.files[0]));

  /* ═══════════════════════════════════════════════
     Step 2: Preview
     ═══════════════════════════════════════════════ */
  previewImg.style.cursor = "zoom-in";
  previewImg.addEventListener("click", () => {
    if (previewUrl) openLightbox(previewUrl, "");
  });

  document.getElementById("btn-retake").addEventListener("click", () => {
    resetFile();
    goTo("step-capture");
  });

  document.getElementById("btn-continue").addEventListener("click", () => {
    formThumb.src = previewUrl;
    goTo("step-form");
    validateForm();
  });

  /* ═══════════════════════════════════════════════
     Step 3: Form
     ═══════════════════════════════════════════════ */
  document.getElementById("btn-back-to-preview").addEventListener("click", () => goTo("step-preview"));

  function validateForm() {
    const filled = selTower.value && selFloor.value && selFlat.value && selRoom.value && selectedFile;
    submitBtn.disabled = !filled;
  }

  [selTower, selFloor, selFlat, selRoom].forEach((sel) => sel.addEventListener("change", validateForm));

  /* ═══════════════════════════════════════════════
     Description STT (Google Web Speech / webkit)
     ═══════════════════════════════════════════════ */
  function setMicState(listening) {
    isListening = listening;
    sttBtn.classList.toggle("stt-btn--active", listening);
    sttBtn.setAttribute("aria-label", listening ? "Stop voice input" : "Start voice input for description");
    descHelp.textContent = listening
      ? "Listening... speak now. Tap Stop when done."
      : "Type manually or use mic for live speech-to-text.";
  }

  function stopRecognition() {
    if (!recognition || !isListening) return;
    recognition.stop();
    setMicState(false);
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    sttBtn.disabled = true;
    descHelp.textContent = "Speech-to-text is not supported in this browser.";
  } else {
    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const phrase = event.results[i][0].transcript;
        if (event.results[i].isFinal) sttFinalText += `${phrase} `;
        else interim += phrase;
      }
      selDescription.value = [sttBaseText, sttFinalText.trim(), interim.trim()].filter(Boolean).join(" ").trim();
    };

    recognition.onend = () => {
      if (isListening) setMicState(false);
    };
    recognition.onerror = () => {
      setMicState(false);
      descHelp.textContent = "Could not capture speech. Please retry or type manually.";
    };

    sttBtn.addEventListener("click", () => {
      if (isListening) {
        stopRecognition();
        return;
      }
      sttBaseText = selDescription.value.trim();
      sttFinalText = "";
      try {
        recognition.start();
        setMicState(true);
      } catch {
        setMicState(false);
      }
    });
  }

  function showAlert(msg) {
    alertEl.textContent = msg;
    alertEl.className = "insp-alert insp-alert--error";
  }

  submitBtn.addEventListener("click", async () => {
    if (!selectedFile) { showAlert("No image selected."); return; }
    if (!selTower.value || !selFloor.value || !selFlat.value || !selRoom.value) {
      showAlert("Please fill all location fields.");
      return;
    }

    submitBtn.disabled = true;
    submitText.innerHTML = '<span class="btn-spinner"></span> Uploading\u2026';

    const fd = new FormData();
    fd.append("image", selectedFile);
    fd.append("tower", selTower.value);
    fd.append("floor", selFloor.value);
    fd.append("flat", selFlat.value);
    fd.append("room", selRoom.value);
    fd.append("description", selDescription.value.trim());

    try {
      const res = await fetch("/api/defects/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json();

      if (!res.ok) {
        showAlert(data.detail || "Upload failed");
        submitBtn.disabled = false;
        submitText.textContent = "Submit";
        return;
      }

      successThumb.src = previewUrl;
      goTo("step-success");
      loadUploads();
    } catch {
      showAlert("Network error \u2014 please retry");
      submitBtn.disabled = false;
    } finally {
      submitText.textContent = "Submit";
    }
  });

  /* ═══════════════════════════════════════════════
     Step 4: Success → restart
     ═══════════════════════════════════════════════ */
  document.getElementById("btn-another").addEventListener("click", () => {
    fullReset();
    goTo("step-capture");
  });

  /* ═══════════════════════════════════════════════
     Reset helpers
     ═══════════════════════════════════════════════ */
  function resetFile() {
    selectedFile = null;
    cameraIn.value = "";
    imageIn.value = "";
    resetStatus();
  }

  function fullReset() {
    stopRecognition();
    resetFile();
    selTower.value = "";
    selFloor.value = "";
    selFlat.value  = "";
    selRoom.value  = "";
    selDescription.value = "";
    submitBtn.disabled = true;
  }

  /* ═══════════════════════════════════════════════
     Lightbox
     ═══════════════════════════════════════════════ */
  const lightbox     = document.getElementById("lightbox");
  const lightboxImg  = document.getElementById("lightbox-img");
  const lightboxMeta = document.getElementById("lightbox-meta");

  function openLightbox(src, meta) {
    lightboxImg.src = src;
    lightboxMeta.textContent = meta || "";
    lightboxMeta.style.display = meta ? "block" : "none";
    lightbox.classList.add("lightbox--open");
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    lightbox.classList.remove("lightbox--open");
    document.body.style.overflow = "";
  }

  document.getElementById("lightbox-close")?.addEventListener("click", closeLightbox);
  lightbox?.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cameraModal?.classList.contains("camera-modal--open")) {
      closeDesktopCameraModal();
      return;
    }
    if (e.key === "Escape" && lightbox?.classList.contains("lightbox--open")) closeLightbox();
  });

  function wireGridLightbox(container) {
    container.querySelectorAll(".insp-item").forEach((item) => {
      const img = item.querySelector("img");
      const metaEl = item.querySelector(".meta");
      if (!img) return;
      img.addEventListener("click", () => openLightbox(img.src, metaEl?.textContent?.trim() || ""));
    });
  }

  function normalizeImageSrc(path) {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    return path.startsWith("/") ? path : `/${path}`;
  }

  /* ═══════════════════════════════════════════════
     Recent uploads — activity bar + expandable list
     ═══════════════════════════════════════════════ */
  const activityBar   = document.getElementById("activity-bar");
  const activityText  = document.getElementById("activity-text");
  const activityThumbs = document.getElementById("activity-thumbs");
  const toggleBtn     = document.getElementById("toggle-all");
  const recentSection = document.getElementById("recent-section");
  const uploadsGrid   = document.getElementById("uploads-grid");
  let recentVisible   = false;

  function todayCount() {
    const today = new Date().toDateString();
    return allUploadItems.filter((d) => new Date(d.created_at).toDateString() === today).length;
  }

  function renderUploads() {
    const grid  = uploadsGrid;
    const empty = document.getElementById("uploads-empty");

    if (allUploadItems.length === 0) {
      activityBar.style.display = "none";
      recentSection.style.display = "none";
      return;
    }

    /* Activity bar */
    const tc = todayCount();
    const total = allUploadItems.length;
    const summaryParts = [];
    if (tc > 0) summaryParts.push(`<strong>${tc}</strong> inspection${tc !== 1 ? "s" : ""} today`);
    if (total > tc) summaryParts.push(`<strong>${total}</strong> total`);
    if (summaryParts.length === 0) summaryParts.push(`<strong>${total}</strong> inspection${total !== 1 ? "s" : ""} uploaded`);
    activityText.innerHTML = summaryParts.join(" &middot; ");

    const thumbs = allUploadItems.slice(0, 3);
    activityThumbs.innerHTML = thumbs.map((d) =>
      `<img src="${normalizeImageSrc(d.image_path)}" alt="" width="32" height="32" loading="lazy">`
    ).join("");

    activityBar.style.display = recentVisible ? "none" : "flex";
    activityBar.classList.toggle("activity-bar--open", recentVisible);
    recentSection.style.display = recentVisible ? "block" : "none";

    if (!recentVisible) return;

    empty.style.display = "none";
    grid.innerHTML = allUploadItems.map((d) => `
      <div class="insp-item">
        <img src="${normalizeImageSrc(d.image_path)}" alt="Defect" loading="lazy">
        <div class="meta">
          <strong>${d.tower}</strong> &middot; Floor ${d.floor} &middot; Flat ${d.flat}<br>
          ${d.room}<br>
          ${d.description ? `<em>${d.description}</em><br>` : ""}
          <small>${new Date(d.created_at).toLocaleString()}</small>
        </div>
      </div>`).join("");

    wireGridLightbox(grid);

    toggleBtn.style.display = "inline";
    toggleBtn.textContent = "Hide";
  }

  activityBar.addEventListener("click", () => {
    recentVisible = true;
    renderUploads();
  });
  activityBar.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activityBar.click(); }
  });

  toggleBtn.addEventListener("click", () => {
    recentVisible = false;
    renderUploads();
  });

  async function loadUploads() {
    try {
      const res = await fetch("/api/defects/my", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      allUploadItems = await res.json();
      renderUploads();
    } catch (err) { console.error("Failed to load uploads:", err); }
  }

  loadUploads();
});
