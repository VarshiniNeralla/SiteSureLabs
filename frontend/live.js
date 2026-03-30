document.addEventListener("DOMContentLoaded", () => {
  const video = document.getElementById("live-video");
  const startBtn = document.getElementById("start-stream-btn");
  const stopBtn = document.getElementById("stop-stream-btn");
  const placeholder = document.getElementById("video-placeholder");
  const statusDot = document.getElementById("stream-status-dot");
  const statusText = document.getElementById("stream-status-text");

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
    if (statusText) statusText.textContent = "Not connected";
  });
});
