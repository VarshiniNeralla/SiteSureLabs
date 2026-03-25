document.addEventListener("DOMContentLoaded", () => {
  // CTA: jump to upload section (no smooth scrolling)
  const navCta = document.getElementById("nav-cta");
  navCta?.addEventListener("click", () => {
    document.getElementById("analysis-section")?.scrollIntoView();
  });

  // ========== IMAGE UPLOAD (basic, no animation) ==========
  const uploadZone = document.getElementById("upload-zone");
  const imageInput = document.getElementById("image-input");
  const previewContainer = document.getElementById("preview-container");
  const originalPreview = document.getElementById("original-preview");
  const segmentedPreview = document.getElementById("segmented-preview");
  const loaderContainer = document.getElementById("segmentation-loader");
  const resetUploadBtn = document.getElementById("reset-upload");
  const analysisStats = document.getElementById("analysis-stats");

  function showPreview(originalDataUrl) {
    originalPreview.src = originalDataUrl;
    segmentedPreview.src = originalDataUrl;

    uploadZone.classList.add("hidden");
    previewContainer.classList.remove("hidden");

    // No spinner/timeout. Just show immediately.
    loaderContainer.classList.add("hidden");
    segmentedPreview.classList.remove("hidden");
    analysisStats.classList.remove("hidden");

    // Simple “segmented” look for demo (still static).
    segmentedPreview.style.filter = "contrast(1.3) saturate(1.6) hue-rotate(90deg)";

    const regions = Math.floor(Math.random() * 5) + 1;
    const conf = 90 + Math.floor(Math.random() * 9);
    document.querySelector(".stat-value.text-green").innerText = String(regions);
    document.querySelector(".stat-value.text-blue").innerText = `${conf}%`;
  }

  // Drag/drop support (no visual animations)
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

  // ========== LIVE STREAM (basic: video only) ==========
  const video = document.getElementById("live-video");
  const startBtn = document.getElementById("start-stream-btn");
  const stopBtn = document.getElementById("stop-stream-btn");
  const placeholder = document.getElementById("video-placeholder");
  const statusDot = document.getElementById("stream-status-dot");
  const statusText = document.getElementById("stream-status-text");

  let stream = null;

  startBtn.addEventListener("click", async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });

      video.srcObject = stream;
      video.classList.remove("hidden");
      placeholder.classList.add("hidden");
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");

      statusDot.classList.add("online");
      statusText.innerText = "Online";
    } catch (err) {
      console.error("Error accessing camera: ", err);
      alert("Could not access camera. Please allow camera permissions.");
    }
  });

  stopBtn.addEventListener("click", () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    video.classList.add("hidden");
    placeholder.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    startBtn.classList.remove("hidden");

    statusDot.classList.remove("online");
    statusText.innerText = "Offline";
  });
});
