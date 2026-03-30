document.addEventListener("DOMContentLoaded", () => {
  const stageUpload = document.getElementById("stage-upload");
  const stageReady = document.getElementById("stage-ready");
  const stageResults = document.getElementById("stage-results");
  const uploadZone = document.getElementById("upload-zone");
  const imageInput = document.getElementById("image-input");
  const addImageBtn = document.getElementById("add-image-btn");
  const readyPreview = document.getElementById("ready-preview");
  const resultOriginal = document.getElementById("result-original");
  const runAnalysisBtn = document.getElementById("run-analysis-btn");
  const cancelReadyBtn = document.getElementById("cancel-ready-btn");
  const analyseMoreBtn = document.getElementById("analyse-more-btn");

  let currentDataUrl = "";

  const showUpload = () => {
    currentDataUrl = "";
    if (imageInput) imageInput.value = "";
    stageUpload?.classList.remove("hidden");
    stageUpload?.removeAttribute("hidden");
    stageReady?.classList.add("hidden");
    stageReady?.setAttribute("hidden", "");
    stageResults?.classList.add("hidden");
    stageResults?.setAttribute("hidden", "");
  };

  const showReady = (dataUrl) => {
    currentDataUrl = dataUrl;
    if (readyPreview) {
      readyPreview.src = dataUrl;
      readyPreview.alt = "Selected image preview";
    }
    stageUpload?.classList.add("hidden");
    stageUpload?.setAttribute("hidden", "");
    stageReady?.classList.remove("hidden");
    stageReady?.removeAttribute("hidden");
    stageResults?.classList.add("hidden");
    stageResults?.setAttribute("hidden", "");
  };

  const showResults = () => {
    if (resultOriginal && currentDataUrl) {
      resultOriginal.src = currentDataUrl;
      resultOriginal.alt = "Uploaded construction image";
    }
    stageUpload?.classList.add("hidden");
    stageUpload?.setAttribute("hidden", "");
    stageReady?.classList.add("hidden");
    stageReady?.setAttribute("hidden", "");
    stageResults?.classList.remove("hidden");
    stageResults?.removeAttribute("hidden");
  };

  addImageBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    imageInput?.click();
  });

  uploadZone?.addEventListener("click", (e) => {
    if (e.target === addImageBtn || addImageBtn?.contains(e.target)) return;
    imageInput?.click();
  });

  uploadZone?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      imageInput?.click();
    }
  });

  let dragDepth = 0;
  const setDragOver = (on) => {
    uploadZone?.classList.toggle("is-dragover", on);
  };

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

  const loadFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result;
      if (typeof url === "string") showReady(url);
    };
    reader.readAsDataURL(file);
  };

  uploadZone?.addEventListener("drop", (e) => {
    dragDepth = 0;
    setDragOver(false);
    const [file] = e.dataTransfer.files || [];
    loadFile(file);
  });

  imageInput?.addEventListener("change", (e) => {
    const [file] = e.target.files || [];
    loadFile(file);
  });

  runAnalysisBtn?.addEventListener("click", () => {
    if (!currentDataUrl) return;
    showResults();
  });

  cancelReadyBtn?.addEventListener("click", () => {
    showUpload();
  });

  analyseMoreBtn?.addEventListener("click", () => {
    showUpload();
  });
});
