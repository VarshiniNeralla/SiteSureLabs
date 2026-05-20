import { getToken, getUser } from "/shared/auth.js";
import { mountDashboardNav } from "/shared/components/dashboard-nav.js";
import { mountDashboardFooter } from "/shared/components/dashboard-footer.js";
import { isHeicLike, normalizeImageFileForUpload } from "/heic-utils.js";
import { optimizeImageForInspection, TARGET_UPLOAD_MAX_BYTES } from "/image-optimize.js";

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

  const selProject = document.getElementById("sel-project");
  const projectFieldWrap = document.getElementById("project-field-wrap");
  const projectLockedHint = document.getElementById("project-locked-hint");
  const btnEditProject = document.getElementById("btn-edit-project");
  const selTower = document.getElementById("sel-tower");
  const selFloor = document.getElementById("sel-floor");
  const selFlat  = document.getElementById("sel-flat");
  const selRoom  = document.getElementById("sel-room");
  const roomOtherWrap = document.getElementById("room-other-wrap");
  const roomOtherDesc = document.getElementById("room-other-desc");
  const categoryOtherWrap = document.getElementById("category-other-wrap");
  const categoryOtherDesc = document.getElementById("category-other-desc");
  const selCategory = document.getElementById("sel-category");
  const ROOM_OTHERS = "Others";
  const CATEGORY_OTHERS = "Others";
  const uploadProgressEl = document.getElementById("upload-progress");
  const uploadProgressFill = document.getElementById("upload-progress-fill");
  const uploadProgressLabel = document.getElementById("upload-progress-label");
  const collectionChipBtn = document.getElementById("btn-open-collection");
  const collectionBackBtn = document.getElementById("btn-back-from-collection");
  const collectionBackLabel = document.getElementById("btn-back-from-collection-label");
  const collectionCountBadgeEl = document.getElementById("collection-count-badge");
  const collectionListEl = document.getElementById("collection-list");
  const collectionEmptyEl = document.getElementById("collection-empty");
  const submitAllBtn = document.getElementById("btn-submit-all");
  const clearCollectionBtn = document.getElementById("btn-clear-collection");
  const backToCaptureBtn = document.getElementById("btn-back-to-capture");
  const collectionToastEl = document.getElementById("collection-toast");
  const collectionEditModal = document.getElementById("collection-edit-modal");
  const collectionEditProject = document.getElementById("collection-edit-project");
  const collectionEditTower = document.getElementById("collection-edit-tower");
  const collectionEditFloor = document.getElementById("collection-edit-floor");
  const collectionEditFlat = document.getElementById("collection-edit-flat");
  const collectionEditRoom = document.getElementById("collection-edit-room");
  const collectionEditRoomOtherWrap = document.getElementById("collection-edit-room-other-wrap");
  const collectionEditRoomOther = document.getElementById("collection-edit-room-other");
  const collectionEditCategory = document.getElementById("collection-edit-category");
  const collectionEditCategoryOtherWrap = document.getElementById("collection-edit-category-other-wrap");
  const collectionEditCategoryOther = document.getElementById("collection-edit-category-other");
  const collectionRemoveModal = document.getElementById("collection-remove-modal");

  let selectedFile = null;
  let previewUrl   = "";
  let allUploadItems = [];
  let desktopCameraStream = null;
  const LEGACY_COLLECTION_STORAGE_KEY = "liveInspectionCollectionV1";
  function buildUserCollectionStorageKey() {
    const userScopeRaw =
      String(user?.user_id || "").trim() ||
      String(user?.email || "").trim().toLowerCase() ||
      "anonymous";
    const userScope = userScopeRaw.replace(/[^\w.-]/g, "_");
    return `liveInspectionCollectionV2:${userScope}`;
  }
  const COLLECTION_STORAGE_KEY = buildUserCollectionStorageKey();
  const DRAFT_STORAGE_KEY = `liveInspectionDraftV2:${String(user?.user_id || user?.email || "anonymous").replace(/[^\w.-]/g, "_")}`;
  const PROJECT_STORAGE_KEY = `liveInspectionProject:${String(user?.user_id || user?.email || "anonymous").replace(/[^\w.-]/g, "_")}`;
  const PROJECT_EDIT_USED_KEY = `liveInspectionProjectEditUsed:${String(user?.user_id || user?.email || "anonymous").replace(/[^\w.-]/g, "_")}`;
  const PROJECT_LOCKED_HINT_DEFAULT =
    "Project is set for this session. You can edit the project name once if needed.";
  const PROJECT_LOCKED_HINT_EDITING =
    "Choose the correct project, then confirm your selection. This is your only project change.";
  let collectionItems = [];
  let editingCollectionIdx = null;
  let pendingRemoveIdx = null;
  let projectEditMode = false;
  /** True only when collection was opened from the details form mid-entry (not after items exist). */
  let collectionBackTargetsDetails = false;

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

  function getLockedProject() {
    try {
      return String(localStorage.getItem(PROJECT_STORAGE_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function setLockedProject(name) {
    const value = String(name || "").trim();
    if (!value) return;
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, value);
    } catch {
      /* ignore quota errors */
    }
  }

  function isProjectEditUsed() {
    try {
      return localStorage.getItem(PROJECT_EDIT_USED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function markProjectEditUsed() {
    try {
      localStorage.setItem(PROJECT_EDIT_USED_KEY, "1");
    } catch {
      /* ignore quota errors */
    }
  }

  function getSessionProject() {
    return getLockedProject() || String(selProject?.value || "").trim();
  }

  function applyProjectFieldState() {
    const locked = getLockedProject();
    if (!selProject) return;
    if (locked) {
      selProject.value = locked;
      if (!projectEditMode) {
        selProject.disabled = true;
        projectFieldWrap?.classList.add("insp-field--locked");
      }
      if (projectLockedHint) {
        projectLockedHint.hidden = false;
        if (!projectEditMode) {
          projectLockedHint.textContent = PROJECT_LOCKED_HINT_DEFAULT;
        }
      }
      if (btnEditProject) {
        btnEditProject.hidden = projectEditMode || isProjectEditUsed();
      }
    } else {
      projectEditMode = false;
      selProject.disabled = false;
      projectFieldWrap?.classList.remove("insp-field--locked");
      if (projectLockedHint) projectLockedHint.hidden = true;
      if (btnEditProject) btnEditProject.hidden = true;
    }
  }

  applyProjectFieldState();

  btnEditProject?.addEventListener("click", () => {
    if (!getLockedProject() || isProjectEditUsed() || projectEditMode) return;
    projectEditMode = true;
    selProject.disabled = false;
    projectFieldWrap?.classList.remove("insp-field--locked");
    if (projectLockedHint) {
      projectLockedHint.hidden = false;
      projectLockedHint.textContent = PROJECT_LOCKED_HINT_EDITING;
    }
    if (btnEditProject) btnEditProject.hidden = true;
    selProject?.focus();
  });

  function finishProjectEdit() {
    const value = selProject?.value.trim();
    if (!value || !projectEditMode) return;
    setLockedProject(value);
    markProjectEditUsed();
    projectEditMode = false;
    applyProjectFieldState();
    validateForm();
    scheduleDraftSave();
  }

  selProject?.addEventListener("change", () => {
    const value = selProject.value.trim();
    if (!value) {
      validateForm();
      scheduleDraftSave();
      return;
    }
    if (projectEditMode) {
      finishProjectEdit();
      return;
    }
    if (!getLockedProject()) {
      setLockedProject(value);
      applyProjectFieldState();
    }
    validateForm();
    scheduleDraftSave();
  });

  selProject?.addEventListener("blur", () => {
    if (projectEditMode && selProject?.value.trim()) {
      finishProjectEdit();
    }
  });

  /* ═══════════════════════════════════════════════
     Populate selects
     ═══════════════════════════════════════════════ */
  for (let i = 1; i <= 60; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = String(i);
    selFloor.appendChild(o);
  }
  const FLAT_OPTIONS = [
    ...Array.from({ length: 10 }, (_, i) => {
      const n = String(i + 1);
      return { value: n, label: n };
    }),
    { value: "Lift Lobby", label: "Lift Lobby" },
    { value: "Staircase 1", label: "Staircase 1" },
    { value: "Staircase 2", label: "Staircase 2" },
  ];
  for (const opt of FLAT_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    selFlat.appendChild(o);
  }

  function cloneSelectOptions(source, target) {
    if (!source || !target) return;
    target.innerHTML = Array.from(source.options)
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.textContent || option.value)}</option>`)
      .join("");
  }

  cloneSelectOptions(selTower, collectionEditTower);
  cloneSelectOptions(selFloor, collectionEditFloor);
  cloneSelectOptions(selFlat, collectionEditFlat);
  cloneSelectOptions(selRoom, collectionEditRoom);
  cloneSelectOptions(selCategory, collectionEditCategory);

  function roomOtherDetail(itemOrRoomOther, maybeDescription) {
    if (itemOrRoomOther && typeof itemOrRoomOther === "object") {
      const item = itemOrRoomOther;
      return String(item.room_other || "").trim()
        || (item.room === ROOM_OTHERS ? String(item.description || "").trim() : "");
    }
    return String(itemOrRoomOther || maybeDescription || "").trim();
  }

  function formatRoomLabel(room, roomOther) {
    const base = String(room || "").trim() || "Room";
    const detail = roomOtherDetail(roomOther);
    if (base === ROOM_OTHERS && detail) return `${ROOM_OTHERS} — ${detail}`;
    return base;
  }

  function categoryOtherDetail(itemOrCategoryOther, maybeDescription) {
    if (itemOrCategoryOther && typeof itemOrCategoryOther === "object") {
      const item = itemOrCategoryOther;
      return String(item.category_other || "").trim();
    }
    return String(itemOrCategoryOther || maybeDescription || "").trim();
  }

  function formatCategoryLabel(category, categoryOther) {
    const base = String(category || "").trim() || "Category";
    const detail = categoryOtherDetail(categoryOther);
    if (base === CATEGORY_OTHERS && detail) return `${CATEGORY_OTHERS} — ${detail}`;
    return base;
  }

  function syncOtherDetailField(selectEl, wrapEl, inputEl, othersValue, selectedValue, detailValue) {
    if (!selectEl || !wrapEl || !inputEl) return;
    const isOthers = String(selectedValue ?? selectEl.value) === othersValue;
    wrapEl.hidden = !isOthers;
    if (isOthers) {
      inputEl.value = String(detailValue ?? inputEl.value ?? "").trim();
    } else {
      inputEl.value = "";
    }
  }

  function syncRoomOtherField(selectEl, wrapEl, inputEl, roomValue, roomOtherValue) {
    syncOtherDetailField(selectEl, wrapEl, inputEl, ROOM_OTHERS, roomValue, roomOtherValue);
  }

  function syncCategoryOtherField(selectEl, wrapEl, inputEl, categoryValue, categoryOtherValue) {
    syncOtherDetailField(selectEl, wrapEl, inputEl, CATEGORY_OTHERS, categoryValue, categoryOtherValue);
  }

  function readOptionalDetailInput(inputEl) {
    return String(inputEl?.value || "").trim();
  }

  function buildUploadDescription(item) {
    const roomPart = item.room === ROOM_OTHERS ? roomOtherDetail(item) : "";
    const categoryPart = item.category === CATEGORY_OTHERS ? categoryOtherDetail(item) : "";
    const parts = [];
    if (roomPart) parts.push(`Room: ${roomPart}`);
    if (categoryPart) parts.push(`Category: ${categoryPart}`);
    if (parts.length) return parts.join(" · ");
    return String(item.description || "").trim();
  }

  function toggleFormRoomOther() {
    syncRoomOtherField(selRoom, roomOtherWrap, roomOtherDesc, selRoom.value, null);
  }

  function toggleFormCategoryOther() {
    syncCategoryOtherField(selCategory, categoryOtherWrap, categoryOtherDesc, selCategory.value, null);
  }

  function toggleCollectionEditRoomOther(roomOtherValue) {
    syncRoomOtherField(
      collectionEditRoom,
      collectionEditRoomOtherWrap,
      collectionEditRoomOther,
      collectionEditRoom?.value,
      roomOtherValue,
    );
  }

  function toggleCollectionEditCategoryOther(categoryOtherValue) {
    syncCategoryOtherField(
      collectionEditCategory,
      collectionEditCategoryOtherWrap,
      collectionEditCategoryOther,
      collectionEditCategory?.value,
      categoryOtherValue,
    );
  }

  selRoom?.addEventListener("change", () => {
    toggleFormRoomOther();
    validateForm();
    scheduleDraftSave();
  });
  selCategory?.addEventListener("change", () => {
    toggleFormCategoryOther();
    validateForm();
    scheduleDraftSave();
  });
  collectionEditRoom?.addEventListener("change", () => {
    toggleCollectionEditRoomOther("");
  });
  collectionEditCategory?.addEventListener("change", () => {
    toggleCollectionEditCategoryOther("");
  });

  /* ═══════════════════════════════════════════════
     Step state machine
     ═══════════════════════════════════════════════ */
  const inspShell = document.querySelector(".insp-shell");
  const liveSecondaryStack = document.getElementById("live-secondary-stack");

  function syncLiveLayout(stepId) {
    const onCollection = stepId === "step-success";
    inspShell?.classList.toggle("live-shell--collection", onCollection);
    if (liveSecondaryStack) liveSecondaryStack.hidden = onCollection;
  }

  function goTo(stepId) {
    panels.forEach((id) => {
      document.getElementById(id).classList.remove("step-panel--active");
    });
    document.getElementById(stepId).classList.add("step-panel--active");
    alertEl.className = "insp-alert";
    updateStepBar(stepId);
    syncLiveLayout(stepId);
    renderUploads();

    if (stepId === "step-capture") startTips();
    else stopTips();
    scheduleDraftSave();
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

  function formatMb(n) {
    return (n / (1024 * 1024)).toFixed(1);
  }

  function setUploadProgress(visible, fraction, label) {
    if (!uploadProgressEl) return;
    uploadProgressEl.hidden = !visible;
    const pct = Math.min(100, Math.max(0, Math.round((fraction || 0) * 100)));
    if (uploadProgressFill) uploadProgressFill.style.width = `${pct}%`;
    if (uploadProgressLabel) uploadProgressLabel.textContent = label || "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function showCollectionToast(text, tone = "") {
    if (!collectionToastEl) return;
    collectionToastEl.textContent = text;
    collectionToastEl.classList.toggle("collection-toast--success", tone === "success");
    collectionToastEl.classList.add("collection-toast--show");
    window.setTimeout(() => {
      collectionToastEl.classList.remove("collection-toast--show");
      collectionToastEl.classList.remove("collection-toast--success");
    }, 1300);
  }

  async function fileToDataUrl(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read image data"));
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToFile(dataUrl, fallbackName) {
    const [header, payload] = String(dataUrl || "").split(",");
    const mimeMatch = /data:(.*?);base64/i.exec(header || "");
    const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const bin = atob(payload || "");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ext = (mime.split("/")[1] || "jpg").replace(/[^\w.-]/g, "");
    return new File([arr], fallbackName || `collection-${Date.now()}.${ext}`, { type: mime });
  }

  function saveCollectionToStorage() {
    try {
      localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(collectionItems));
    } catch {
      // Ignore storage quota issues; collection still works in-memory.
    }
    scheduleDraftSave();
  }

  function loadCollectionFromStorage() {
    try {
      const raw = localStorage.getItem(COLLECTION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) collectionItems = parsed;
      else collectionItems = [];

      // Remove old shared drafts key so collections no longer leak across users.
      if (localStorage.getItem(LEGACY_COLLECTION_STORAGE_KEY) !== null) {
        localStorage.removeItem(LEGACY_COLLECTION_STORAGE_KEY);
      }
    } catch {
      collectionItems = [];
    }
  }

  let draftSaveTimer = null;
  let draftSaveInFlight = false;

  function getActiveStepId() {
    return panels.find((id) => document.getElementById(id)?.classList.contains("step-panel--active")) || "step-capture";
  }

  function clearDraftFromStorage() {
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function collectDraftFormFields() {
    return {
      project: String(selProject?.value || "").trim(),
      tower: String(selTower?.value || "").trim(),
      floor: String(selFloor?.value || "").trim(),
      flat: String(selFlat?.value || "").trim(),
      room: String(selRoom?.value || "").trim(),
      room_other: readOptionalDetailInput(roomOtherDesc),
      category: String(selCategory?.value || "").trim(),
      category_other: readOptionalDetailInput(categoryOtherDesc),
    };
  }

  function applyDraftFormFields(draft) {
    if (!draft || typeof draft !== "object") return;
    if (selProject && draft.project) selProject.value = draft.project;
    if (selTower && draft.tower) selTower.value = draft.tower;
    if (selFloor && draft.floor) selFloor.value = draft.floor;
    if (selFlat && draft.flat) selFlat.value = draft.flat;
    if (selRoom && draft.room) selRoom.value = draft.room;
    if (selCategory && draft.category) selCategory.value = draft.category;
    if (roomOtherDesc && draft.room_other) roomOtherDesc.value = draft.room_other;
    if (categoryOtherDesc && draft.category_other) categoryOtherDesc.value = draft.category_other;
    applyProjectFieldState();
    toggleFormRoomOther();
    toggleFormCategoryOther();
  }

  function persistDraftPayload(payload) {
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      if (payload.imageDataUrl) {
        try {
          localStorage.setItem(
            DRAFT_STORAGE_KEY,
            JSON.stringify({ ...payload, imageDataUrl: "", imagePersistFailed: true }),
          );
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  async function saveDraftToStorage() {
    if (draftSaveInFlight) return;
    draftSaveInFlight = true;
    try {
      let imageDataUrl = "";
      if (selectedFile) {
        try {
          imageDataUrl = await fileToDataUrl(selectedFile);
        } catch {
          imageDataUrl = "";
        }
      }

      const activeStep = getActiveStepId();
      const payload = {
        version: 1,
        activeStep,
        imageDataUrl,
        fileName: selectedFile?.name || "",
        ...collectDraftFormFields(),
        collectionBackTargetsDetails,
        updatedAt: new Date().toISOString(),
      };
      persistDraftPayload(payload);
    } finally {
      draftSaveInFlight = false;
    }
  }

  function scheduleDraftSave() {
    if (draftSaveTimer) window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(() => {
      void saveDraftToStorage();
    }, 350);
  }

  async function restoreDraftFromStorage() {
    let draft;
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return false;
      draft = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!draft || typeof draft !== "object" || draft.version !== 1) return false;

    applyDraftFormFields(draft);
    collectionBackTargetsDetails = Boolean(draft.collectionBackTargetsDetails);

    if (draft.imageDataUrl) {
      try {
        selectedFile = dataUrlToFile(draft.imageDataUrl, draft.fileName || `restored-${Date.now()}.jpg`);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(selectedFile);
        previewImg.src = previewUrl;
        if (formThumb) formThumb.src = previewUrl;
        statusEl.textContent = draft.imagePersistFailed
          ? "Image could not be fully restored — please re-select the photo."
          : "Image restored ✓";
        statusEl.className = draft.imagePersistFailed
          ? "capture-status capture-status--error"
          : "capture-status capture-status--ready";
      } catch {
        resetFile();
      }
    }

    let step = panels.includes(draft.activeStep) ? draft.activeStep : "step-capture";
    if ((step === "step-preview" || step === "step-form") && !selectedFile) {
      step = collectionItems.length > 0 ? "step-success" : "step-capture";
    }
    if (step === "step-form" && selectedFile) {
      if (formThumb) formThumb.src = previewUrl;
    }

    goTo(step);
    if (step === "step-form") validateForm();
    updateCollectionBackButton();
    const hasFormData = Boolean(
      draft.tower || draft.floor || draft.flat || draft.room || draft.category || draft.imageDataUrl,
    );
    if (hasFormData || collectionItems.length > 0) {
      showCollectionToast("Restored your in-progress inspection", "success");
    }
    return true;
  }

  window.addEventListener("beforeunload", () => {
    void saveDraftToStorage();
  });

  /* ═══════════════════════════════════════════════
     Step 1: Capture
     ═══════════════════════════════════════════════ */
  async function processPickedFile(rawFile) {
    if (!rawFile) return;
    const mime = String(rawFile.type || "").toLowerCase();
    if (!mime.startsWith("image/") && !isHeicLike(rawFile)) {
      setCaptureError("Please choose an image file.");
      return;
    }

    statusEl.className = "capture-status capture-status--busy";
    statusEl.textContent = "Processing image…";

    const originalSize = rawFile.size || 0;

    try {
      const normalized = await normalizeImageFileForUpload(rawFile);
      if (!normalized) {
        setCaptureError("Unsupported image format.");
        return;
      }

      const optimized = await optimizeImageForInspection(normalized, {
        status: (msg) => {
          statusEl.textContent = msg;
        },
      });

      selectedFile = optimized;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(optimized);
      previewImg.src = previewUrl;

      const newSize = optimized.size || 0;
      if (originalSize > newSize * 1.15 && originalSize > TARGET_UPLOAD_MAX_BYTES * 0.85) {
        statusEl.textContent = `Ready — optimized ${formatMb(originalSize)} MB → ${formatMb(newSize)} MB ✓`;
      } else {
        statusEl.textContent = "Image ready ✓";
      }
      statusEl.className = "capture-status capture-status--ready";

      goTo("step-preview");
      scheduleDraftSave();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCaptureError(msg || "Could not process this image.");
    }
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

  async function listVideoInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  function pickPreferredVideoInput(videoInputs) {
    if (!videoInputs.length) return null;
    if (videoInputs.length === 1) return videoInputs[0];

    const externalHint = /(usb|webcam|hd|logitech|brio|c9\d{2}|stream|external)/i;
    const internalHint = /(integrated|built[- ]in|internal|facetime)/i;

    const external = videoInputs.find((d) => externalHint.test(d.label || ""));
    if (external) return external;

    const nonInternal = videoInputs.find((d) => !internalHint.test(d.label || ""));
    return nonInternal || videoInputs[0];
  }

  async function openBestAvailableCameraStream() {
    // First permissive probe: this succeeds on most browsers/devices and unlocks labels.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

    const currentTrack = probe.getVideoTracks()[0];
    const currentSettings = currentTrack?.getSettings?.() || {};
    const currentDeviceId = currentSettings.deviceId || null;

    const videoInputs = await listVideoInputs();
    const preferred = pickPreferredVideoInput(videoInputs);
    const preferredId = preferred?.deviceId || null;

    // If there is no better camera candidate, keep the already-open stream.
    if (!preferredId || !currentDeviceId || preferredId === currentDeviceId) {
      return probe;
    }

    probe.getTracks().forEach((track) => track.stop());

    // Try selected external/preferred camera; fall back to permissive stream if unavailable.
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: preferredId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
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
      await stopDesktopCamera();
      desktopCameraStream = await openBestAvailableCameraStream();
    } catch (err) {
      const name = err && err.name ? err.name : "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCaptureError("No camera detected on this device.");
      } else if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setCaptureError("Camera access denied. Allow permission and try again.");
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        setCaptureError("Camera is busy in another app. Close it there and try again.");
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
    await processPickedFile(file);
  }

  document.getElementById("btn-take-photo").addEventListener("click", () => {
    if (isMobileLikeDevice()) {
      // Force direct camera intent on mobile while keeping lighter image formats.
      cameraIn.setAttribute("accept", "image/jpeg,image/png,image/webp");
      cameraIn.setAttribute("capture", "environment");
      cameraIn.click();
      return;
    }
    openDesktopCameraModal();
  });
  document.getElementById("btn-upload-image").addEventListener("click", () => {
    imageIn.removeAttribute("capture");
    imageIn.click();
  });

  cameraCaptureBtn?.addEventListener("click", captureDesktopFrame);
  cameraCancelBtn?.addEventListener("click", closeDesktopCameraModal);
  cameraModalCloseBtn?.addEventListener("click", closeDesktopCameraModal);
  cameraModal?.addEventListener("click", (e) => {
    if (e.target === cameraModal) closeDesktopCameraModal();
  });

  cameraIn.addEventListener("change", async () => {
    const f = cameraIn.files && cameraIn.files[0];
    cameraIn.value = "";
    try {
      await processPickedFile(f);
    } catch {
      setCaptureError("Camera capture failed on this device. Use Upload Image as fallback.");
    }
  });
  imageIn.addEventListener("change", async () => {
    const f = imageIn.files && imageIn.files[0];
    imageIn.value = "";
    await processPickedFile(f);
  });

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
    scheduleDraftSave();
  });

  document.getElementById("btn-continue").addEventListener("click", () => {
    formThumb.src = previewUrl;
    goTo("step-form");
    applyProjectFieldState();
    toggleFormRoomOther();
    toggleFormCategoryOther();
    validateForm();
  });

  /* ═══════════════════════════════════════════════
     Step 3: Form
     ═══════════════════════════════════════════════ */
  document.getElementById("btn-back-to-preview").addEventListener("click", () => goTo("step-preview"));

  function validateForm() {
    const projectOk = Boolean(getSessionProject());
    const filled = projectOk && selTower.value && selFloor.value && selFlat.value && selRoom.value && selCategory.value && selectedFile;
    submitBtn.disabled = !filled;
  }

  function onFormFieldChange() {
    validateForm();
    scheduleDraftSave();
  }
  [selProject, selTower, selFloor, selFlat, selCategory].forEach((sel) => sel?.addEventListener("change", onFormFieldChange));
  roomOtherDesc?.addEventListener("input", onFormFieldChange);
  categoryOtherDesc?.addEventListener("input", onFormFieldChange);

  function showAlert(msg) {
    alertEl.textContent = msg;
    alertEl.className = "insp-alert insp-alert--error";
  }

  function updateCollectionIndicator() {
    const n = collectionItems.length;
    if (collectionCountBadgeEl) collectionCountBadgeEl.textContent = String(n);
    if (collectionChipBtn) {
      collectionChipBtn.setAttribute(
        "aria-label",
        n === 0 ? "Open collection, currently empty" : `Open collection, ${n} items ready`,
      );
    }
    if (submitAllBtn) {
      submitAllBtn.textContent = `Submit All (${n})`;
      submitAllBtn.disabled = n === 0;
    }
    if (clearCollectionBtn) clearCollectionBtn.disabled = n === 0;
  }

  function renderCollectionList() {
    if (!collectionListEl || !collectionEmptyEl) return;
    updateCollectionIndicator();
    if (!collectionItems.length) {
      collectionListEl.innerHTML = "";
      collectionEmptyEl.hidden = false;
      if (document.getElementById("step-success")?.classList.contains("step-panel--active")) {
        updateCollectionBackButton();
      }
      return;
    }
    collectionEmptyEl.hidden = true;
    collectionListEl.innerHTML = collectionItems.map((item, idx) => `
      <article class="collection-item" data-idx="${idx}">
        <div class="collection-item__top">
          <button type="button" class="collection-item__img-wrap" data-preview="${idx}" aria-label="Preview collection image ${idx + 1}">
            <img class="collection-item__img" src="${escapeHtml(item.preview_url || item.image_data_url || "")}" alt="Collection item ${idx + 1}">
          </button>
          <div class="collection-item__summary">
            <div class="collection-item__meta">
              <p class="collection-item__line collection-item__line--primary">${escapeHtml(item.project || getLockedProject() || "—")} · ${escapeHtml(item.tower || "—")} · Floor ${escapeHtml(item.floor || "—")}</p>
              <p class="collection-item__line">Flat ${escapeHtml(item.flat || "—")} · ${escapeHtml(formatRoomLabel(item.room, roomOtherDetail(item)) || "—")} · ${escapeHtml(formatCategoryLabel(item.category, categoryOtherDetail(item)) || "—")}</p>
            </div>
            <div class="collection-item__actions">
              <button type="button" class="collection-item__edit" data-edit="${idx}" aria-expanded="false">Edit</button>
              <button type="button" class="collection-item__remove" data-remove="${idx}" aria-label="Remove collection item ${idx + 1}">Remove</button>
            </div>
          </div>
        </div>
      </article>
    `).join("");
    if (document.getElementById("step-success")?.classList.contains("step-panel--active")) {
      updateCollectionBackButton();
    }
  }

  function openCollectionEditModal(idx) {
    const item = collectionItems[idx];
    if (!item || !collectionEditModal) return;
    editingCollectionIdx = idx;
    if (collectionEditProject) {
      collectionEditProject.textContent = item.project || getLockedProject() || "—";
    }
    setSelectValue(collectionEditTower, item.tower || "");
    setSelectValue(collectionEditFloor, item.floor || "");
    setSelectValue(collectionEditFlat, item.flat || "");
    setSelectValue(collectionEditRoom, item.room || "");
    toggleCollectionEditRoomOther(roomOtherDetail(item));
    setSelectValue(collectionEditCategory, item.category || "");
    toggleCollectionEditCategoryOther(categoryOtherDetail(item));
    collectionEditModal.classList.add("collection-modal--open");
    document.body.style.overflow = "hidden";
    window.setTimeout(() => collectionEditTower?.focus(), 0);
  }

  function setSelectValue(select, value) {
    if (!select) return;
    const normalized = String(value || "");
    select.value = Array.from(select.options).some((option) => option.value === normalized)
      ? normalized
      : "";
  }

  function closeCollectionEditModal() {
    collectionEditModal?.classList.remove("collection-modal--open");
    editingCollectionIdx = null;
    if (collectionEditRoomOther) collectionEditRoomOther.value = "";
    collectionEditRoomOtherWrap && (collectionEditRoomOtherWrap.hidden = true);
    if (collectionEditCategoryOther) collectionEditCategoryOther.value = "";
    collectionEditCategoryOtherWrap && (collectionEditCategoryOtherWrap.hidden = true);
    document.body.style.overflow = "";
  }

  function saveCollectionEditModal() {
    if (!Number.isInteger(editingCollectionIdx) || !collectionItems[editingCollectionIdx]) return;
    const editRoom = collectionEditRoom.value.trim();
    const editCategory = collectionEditCategory.value.trim();
    const editRoomOther = editRoom === ROOM_OTHERS ? readOptionalDetailInput(collectionEditRoomOther) : "";
    const editCategoryOther = editCategory === CATEGORY_OTHERS ? readOptionalDetailInput(collectionEditCategoryOther) : "";
    const updated = {
      ...collectionItems[editingCollectionIdx],
      project: collectionItems[editingCollectionIdx].project || getLockedProject() || "",
      tower: collectionEditTower.value.trim(),
      floor: collectionEditFloor.value.trim(),
      flat: collectionEditFlat.value.trim(),
      room: editRoom,
      room_other: editRoomOther,
      category: editCategory,
      category_other: editCategoryOther,
    };
    collectionItems[editingCollectionIdx] = {
      ...updated,
      description: buildUploadDescription(updated),
    };
    saveCollectionToStorage();
    renderCollectionList();
    closeCollectionEditModal();
    showCollectionToast("✓ Successfully changed", "success");
  }

  function openRemoveConfirmModal(idx) {
    if (!collectionItems[idx] || !collectionRemoveModal) return;
    pendingRemoveIdx = idx;
    collectionRemoveModal.classList.add("collection-modal--open");
    document.body.style.overflow = "hidden";
  }

  function closeRemoveConfirmModal() {
    collectionRemoveModal?.classList.remove("collection-modal--open");
    pendingRemoveIdx = null;
    document.body.style.overflow = "";
  }

  function confirmRemoveCollectionItem() {
    if (!Number.isInteger(pendingRemoveIdx) || !collectionItems[pendingRemoveIdx]) return;
    collectionItems.splice(pendingRemoveIdx, 1);
    saveCollectionToStorage();
    renderCollectionList();
    closeRemoveConfirmModal();
  }

  collectionListEl?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const previewButton = target.closest("[data-preview]");
    if (previewButton instanceof HTMLElement) {
      const previewIdx = Number(previewButton.getAttribute("data-preview"));
      const item = collectionItems[previewIdx];
      const src = item?.preview_url || item?.image_data_url || "";
      if (src) {
        const meta = `${item.project || getLockedProject() || "Project"} • ${item.tower || "Tower"} • Floor ${item.floor || "-"} • Flat ${item.flat || "-"}`;
        openLightbox(src, meta);
      }
      return;
    }
    const editButton = target.closest("[data-edit]");
    if (editButton instanceof HTMLElement) {
      const editIdx = Number(editButton.getAttribute("data-edit"));
      openCollectionEditModal(editIdx);
      return;
    }
    const removeButton = target.closest("[data-remove]");
    if (!(removeButton instanceof HTMLElement)) return;
    const idx = Number(removeButton.getAttribute("data-remove"));
    if (!Number.isInteger(idx)) return;
    openRemoveConfirmModal(idx);
  });

  submitBtn.addEventListener("click", async () => {
    if (!selectedFile) { showAlert("No image selected."); return; }
    const project = getSessionProject();
    if (!project || !selTower.value || !selFloor.value || !selFlat.value || !selRoom.value || !selCategory.value) {
      showAlert("Please select project and fill all location fields including category.");
      return;
    }
    if (!getLockedProject()) {
      setLockedProject(project);
      applyProjectFieldState();
    }
    submitBtn.disabled = true;
    submitText.innerHTML = '<span class="btn-spinner"></span> Adding...';
    try {
      const imageDataUrl = await fileToDataUrl(selectedFile);
      const draft = {
        id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        preview_url: imageDataUrl,
        image_data_url: imageDataUrl,
        file_name: selectedFile.name || `capture-${Date.now()}.jpg`,
        project,
        tower: selTower.value,
        floor: selFloor.value,
        flat: selFlat.value,
        room: selRoom.value,
        room_other: selRoom.value === ROOM_OTHERS ? readOptionalDetailInput(roomOtherDesc) : "",
        category: selCategory.value,
        category_other: selCategory.value === CATEGORY_OTHERS ? readOptionalDetailInput(categoryOtherDesc) : "",
      };
      collectionItems.push({
        ...draft,
        description: buildUploadDescription(draft),
      });
      saveCollectionToStorage();
      renderCollectionList();
      showCollectionToast(`Added ✓ (${collectionItems.length} in collection)`);
      collectionChipBtn?.classList.add("collection-chip--pulse");
      window.setTimeout(() => collectionChipBtn?.classList.remove("collection-chip--pulse"), 900);
      fullReset();
      goTo("step-capture");
    } finally {
      submitText.textContent = "Add to Collection";
      validateForm();
    }
  });

  async function submitCollectionBatch() {
    if (!collectionItems.length || !submitAllBtn) return;
    submitAllBtn.disabled = true;
    submitAllBtn.innerHTML = '<span class="btn-spinner"></span> Submitting...';
    setUploadProgress(true, 0, "Submitting collection...");
    try {
      const fd = new FormData();
      const sessionProject = getLockedProject();
      fd.append("items_json", JSON.stringify(collectionItems.map((item) => ({
        project: item.project || sessionProject || "",
        tower: item.tower || "",
        floor: item.floor || "",
        flat: item.flat || "",
        room: item.room || "",
        category: item.category || "",
        description: buildUploadDescription(item),
      }))));
      for (const item of collectionItems) {
        fd.append("images", dataUrlToFile(item.image_data_url, item.file_name));
      }

      const res = await fetch("/api/defects/upload-batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showAlert(typeof data?.detail === "string" ? data.detail : "Batch submission failed.");
        return;
      }
      const failures = Array.isArray(data.results) ? data.results.filter((r) => !r.ok) : [];
      if (failures.length) {
        showAlert(`Submitted with ${failures.length} failure(s). Please review collection and retry.`);
        return;
      }
      collectionItems = [];
      saveCollectionToStorage();
      renderCollectionList();
      fullReset();
      showCollectionToast(`✓ Submitted successfully (${data.success_count || 0})`, "success");
      goTo("step-capture");
      loadUploads();
    } catch (err) {
      showAlert(err instanceof Error ? err.message : "Batch submission failed.");
    } finally {
      setUploadProgress(false, 0, "");
      updateCollectionIndicator();
    }
  }

  function shouldCollectionBackToDetails() {
    return collectionBackTargetsDetails;
  }

  function updateCollectionBackButton() {
    const label = shouldCollectionBackToDetails() ? "Back to details" : "Back to capture";
    if (collectionBackLabel) collectionBackLabel.textContent = label;
    if (collectionBackBtn) collectionBackBtn.setAttribute("aria-label", label);
  }

  function openCollectionView() {
    const activePanel = panels.find((id) =>
      document.getElementById(id)?.classList.contains("step-panel--active"),
    );
    collectionBackTargetsDetails =
      activePanel === "step-form" && Boolean(selectedFile || previewUrl);
    renderCollectionList();
    updateCollectionBackButton();
    goTo("step-success");
  }

  function leaveCollectionView() {
    if (shouldCollectionBackToDetails()) {
      goTo("step-form");
      applyProjectFieldState();
      toggleFormRoomOther();
      toggleFormCategoryOther();
      validateForm();
      return;
    }
    goTo("step-capture");
  }

  collectionChipBtn?.addEventListener("click", () => {
    if (document.getElementById("step-success")?.classList.contains("step-panel--active")) {
      leaveCollectionView();
      return;
    }
    openCollectionView();
  });
  collectionBackBtn?.addEventListener("click", leaveCollectionView);
  backToCaptureBtn?.addEventListener("click", () => goTo("step-capture"));
  clearCollectionBtn?.addEventListener("click", () => {
    collectionItems = [];
    saveCollectionToStorage();
    renderCollectionList();
  });
  submitAllBtn?.addEventListener("click", submitCollectionBatch);
  document.getElementById("collection-edit-close")?.addEventListener("click", closeCollectionEditModal);
  document.getElementById("collection-edit-cancel")?.addEventListener("click", closeCollectionEditModal);
  document.getElementById("collection-edit-save")?.addEventListener("click", saveCollectionEditModal);
  collectionEditModal?.addEventListener("click", (e) => {
    if (e.target === collectionEditModal) closeCollectionEditModal();
  });
  document.getElementById("collection-remove-close")?.addEventListener("click", closeRemoveConfirmModal);
  document.getElementById("collection-remove-cancel")?.addEventListener("click", closeRemoveConfirmModal);
  document.getElementById("collection-remove-confirm")?.addEventListener("click", confirmRemoveCollectionItem);
  collectionRemoveModal?.addEventListener("click", (e) => {
    if (e.target === collectionRemoveModal) closeRemoveConfirmModal();
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
    clearDraftFromStorage();
    resetFile();
    if (!getLockedProject() && selProject) selProject.value = "";
    applyProjectFieldState();
    selTower.value = "";
    selFloor.value = "";
    selFlat.value  = "";
    selRoom.value  = "";
    if (roomOtherDesc) roomOtherDesc.value = "";
    toggleFormRoomOther();
    selCategory.value = "";
    if (categoryOtherDesc) categoryOtherDesc.value = "";
    toggleFormCategoryOther();
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
    if (e.key === "Escape" && collectionEditModal?.classList.contains("collection-modal--open")) {
      closeCollectionEditModal();
      return;
    }
    if (e.key === "Escape" && collectionRemoveModal?.classList.contains("collection-modal--open")) {
      closeRemoveConfirmModal();
      return;
    }
    if (e.key === "Escape" && document.getElementById("step-success")?.classList.contains("step-panel--active")) {
      leaveCollectionView();
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
    const onCollection = document.getElementById("step-success")?.classList.contains("step-panel--active");

    if (onCollection) {
      recentVisible = false;
      activityBar.style.display = "none";
      recentSection.style.display = "none";
      return;
    }

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
          ${d.project ? `<strong>${escapeHtml(d.project)}</strong> &middot; ` : ""}<strong>${escapeHtml(d.tower)}</strong> &middot; Floor ${escapeHtml(d.floor)} &middot; Flat ${escapeHtml(d.flat)}<br>
          ${d.room}<br>
          ${d.category ? `Category: ${d.category}<br>` : ""}
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

  updateCollectionBackButton();
  loadCollectionFromStorage();
  renderCollectionList();
  void (async () => {
    const restored = await restoreDraftFromStorage();
    if (!restored && collectionItems.length > 0) {
      goTo("step-success");
      updateCollectionBackButton();
    }
  })();
  loadUploads();
});
