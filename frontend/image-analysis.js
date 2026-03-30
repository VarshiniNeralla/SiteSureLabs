document.addEventListener("DOMContentLoaded", () => {
  const uploadZone = document.getElementById("upload-zone");
  const imageInput = document.getElementById("image-input");
  const previewContainer = document.getElementById("preview-container");
  const originalPreview = document.getElementById("original-preview");
  const segmentedPreview = document.getElementById("segmented-preview");
  const loaderContainer = document.getElementById("segmentation-loader");
  const resetUploadBtn = document.getElementById("reset-upload");
  const analysisStats = document.getElementById("analysis-stats");
  const analyzeBtn = document.getElementById("analyze-image-btn");

  const mqNavMobile = window.matchMedia("(max-width: 760px)");
  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("primary-nav");

  const setNavOpen = (open) => {
    if (!navToggle || !navLinks) return;
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navLinks.classList.toggle("is-open", open);
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
    if (e.key === "Escape") setNavOpen(false);
  });

  document.addEventListener("click", (e) => {
    if (!mqNavMobile.matches || !navLinks?.classList.contains("is-open")) return;
    const nav = document.getElementById("navbar");
    if (nav && !nav.contains(e.target)) setNavOpen(false);
  });

  mqNavMobile.addEventListener("change", () => {
    if (!mqNavMobile.matches) setNavOpen(false);
  });

  analyzeBtn?.addEventListener("click", () => imageInput?.click());

  uploadZone?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      analyzeBtn?.click();
    }
  });

  let dragDepth = 0;
  const setDragOver = (on) => {
    uploadZone?.classList.toggle("is-dragover", on);
  };

  function showPreview(originalDataUrl) {
    if (!originalPreview || !segmentedPreview || !uploadZone || !previewContainer) return;
    originalPreview.src = originalDataUrl;
    segmentedPreview.src = originalDataUrl;
    uploadZone.classList.add("hidden");
    previewContainer.classList.remove("hidden");
    loaderContainer?.classList.add("hidden");
    segmentedPreview.classList.remove("hidden");
    analysisStats?.classList.remove("hidden");
    segmentedPreview.style.filter = "contrast(1.3) saturate(1.6) hue-rotate(90deg)";

    const regions = Math.floor(Math.random() * 5) + 1;
    const conf = 90 + Math.floor(Math.random() * 9);
    const greenStat = document.querySelector(".stat-value.text-green");
    const blueStat = document.querySelector(".stat-value.text-blue");
    if (greenStat) greenStat.textContent = String(regions);
    if (blueStat) blueStat.textContent = `${conf}%`;
  }

  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    uploadZone?.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  uploadZone?.addEventListener("dragenter", () => {
    dragDepth += 1;
    setDragOver(true);
  });

  uploadZone?.addEventListener("dragleave", () => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      setDragOver(false);
    }
  });

  uploadZone?.addEventListener("drop", (e) => {
    dragDepth = 0;
    setDragOver(false);
    const [file] = e.dataTransfer.files || [];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => showPreview(ev.target.result);
    reader.readAsDataURL(file);
  });

  imageInput?.addEventListener("change", (e) => {
    const [file] = e.target.files || [];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => showPreview(ev.target.result);
    reader.readAsDataURL(file);
  });

  resetUploadBtn?.addEventListener("click", () => {
    previewContainer?.classList.add("hidden");
    uploadZone?.classList.remove("hidden");
    if (imageInput) imageInput.value = "";
    if (segmentedPreview) segmentedPreview.style.filter = "none";
  });
});
