document.addEventListener("DOMContentLoaded", () => {
  const video = document.getElementById("live-video");
  const startBtn = document.getElementById("start-stream-btn");
  const stopBtn = document.getElementById("stop-stream-btn");
  const placeholder = document.getElementById("video-placeholder");
  const statusDot = document.getElementById("stream-status-dot");
  const statusText = document.getElementById("stream-status-text");
  const livePanel = document.getElementById("live-panel");

  let stream = null;

  startBtn?.addEventListener("click", async () => {
    if (!video || !placeholder || !stopBtn) return;
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
      statusDot?.classList.add("online");
      livePanel?.classList.add("is-live");
      if (statusText) statusText.textContent = "Connected";
    } catch (err) {
      console.error("Error accessing camera: ", err);
      alert("Could not access camera. Please allow camera permissions.");
    }
  });

  stopBtn?.addEventListener("click", () => {
    if (!video || !placeholder || !startBtn) return;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    video.classList.add("hidden");
    placeholder.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    startBtn.classList.remove("hidden");
    statusDot?.classList.remove("online");
    livePanel?.classList.remove("is-live");
    if (statusText) statusText.textContent = "Not connected";
  });
});
