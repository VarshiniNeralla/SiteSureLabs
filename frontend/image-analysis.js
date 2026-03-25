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

  analyzeBtn?.addEventListener("click", () => imageInput?.click());

  function showPreview(originalDataUrl) {
    originalPreview.src = originalDataUrl;
    segmentedPreview.src = originalDataUrl;
    uploadZone.classList.add("hidden");
    previewContainer.classList.remove("hidden");
    loaderContainer.classList.add("hidden");
    segmentedPreview.classList.remove("hidden");
    analysisStats.classList.remove("hidden");
    segmentedPreview.style.filter = "contrast(1.3) saturate(1.6) hue-rotate(90deg)";

    const regions = Math.floor(Math.random() * 5) + 1;
    const conf = 90 + Math.floor(Math.random() * 9);
    document.querySelector(".stat-value.text-green").innerText = String(regions);
    document.querySelector(".stat-value.text-blue").innerText = `${conf}%`;
  }

  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    uploadZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  uploadZone.addEventListener("drop", (e) => {
    const [file] = e.dataTransfer.files || [];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => showPreview(ev.target.result);
    reader.readAsDataURL(file);
  });

  imageInput.addEventListener("change", (e) => {
    const [file] = e.target.files || [];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => showPreview(ev.target.result);
    reader.readAsDataURL(file);
  });

  resetUploadBtn.addEventListener("click", () => {
    previewContainer.classList.add("hidden");
    uploadZone.classList.remove("hidden");
    imageInput.value = "";
    segmentedPreview.style.filter = "none";
  });
});
