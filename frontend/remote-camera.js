document.addEventListener("DOMContentLoaded", () => {
  const stateConnecting = document.getElementById("state-connecting");
  const statePermission = document.getElementById("state-permission");
  const stateStreaming = document.getElementById("state-streaming");
  const stateError = document.getElementById("state-error");
  const errorMessage = document.getElementById("error-message");
  const video = document.getElementById("remote-video");
  const startCameraBtn = document.getElementById("start-camera-btn");
  const stopCameraBtn = document.getElementById("stop-camera-btn");
  const retryBtn = document.getElementById("retry-btn");

  let peer = null;
  let stream = null;
  let activeCall = null;
  let qualityInterval = null;

  const params = new URLSearchParams(window.location.search);
  const hostPeerId = params.get("session");

  if (!hostPeerId) {
    showState("error", "No session ID found. Please scan the QR code again from the Live Inspection page.");
    return;
  }

  function showState(state, errMsg) {
    stateConnecting.classList.add("hidden");
    statePermission.classList.add("hidden");
    stateStreaming.classList.add("hidden");
    stateError.classList.add("hidden");

    switch (state) {
      case "connecting":
        stateConnecting.classList.remove("hidden");
        break;
      case "permission":
        statePermission.classList.remove("hidden");
        break;
      case "streaming":
        stateStreaming.classList.remove("hidden");
        break;
      case "error":
        if (errMsg) errorMessage.textContent = errMsg;
        stateError.classList.remove("hidden");
        break;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  /* ── Quality helpers ── */

  /** Prefer H264 codec in SDP for hardware-accelerated, higher quality encoding */
  function preferH264(sdp) {
    const lines = sdp.split("\r\n");
    const mVideoIdx = lines.findIndex((l) => l.startsWith("m=video"));
    if (mVideoIdx === -1) return sdp;

    /* Collect payload types for H264 */
    const h264Pts = [];
    const otherPts = [];
    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+)\s+(H264|VP8|VP9|AV1)\//i);
      if (match) {
        if (match[2].toUpperCase() === "H264") h264Pts.push(match[1]);
        else otherPts.push(match[1]);
      }
    }

    if (h264Pts.length === 0) return sdp;

    /* Reorder the m=video line: H264 payload types first */
    const mLine = lines[mVideoIdx];
    const parts = mLine.split(" ");
    /* parts: m=video PORT PROTO PT1 PT2 ... */
    const header = parts.slice(0, 3);
    const pts = parts.slice(3);
    const reordered = [
      ...h264Pts,
      ...pts.filter((pt) => !h264Pts.includes(pt))
    ];
    lines[mVideoIdx] = [...header, ...reordered].join(" ");
    return lines.join("\r\n");
  }

  /** Set bitrate caps in SDP */
  function setSdpBitrate(sdp, kbps) {
    let out = sdp.replace(/b=AS:[^\r\n]+\r?\n/g, "");
    out = out.replace(/(m=video [^\r\n]+)/g, `$1\r\nb=AS:${kbps}`);
    return out;
  }

  /** Enhance SDP: prefer H264 + set high bitrate */
  function enhanceSdp(sdp) {
    return setSdpBitrate(preferH264(sdp), 15000);
  }

  /** Override setLocalDescription on a PeerConnection to inject enhanced SDP */
  function patchSdp(pc) {
    const origSetLocal = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = (desc) => {
      if (desc && desc.sdp) desc.sdp = enhanceSdp(desc.sdp);
      return origSetLocal(desc);
    };
    const origSetRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = (desc) => {
      if (desc && desc.sdp) desc.sdp = setSdpBitrate(desc.sdp, 15000);
      return origSetRemote(desc);
    };
  }

  /** Force sender encoding parameters for maximum quality */
  function applyEncodingParams(pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    const p = sender.getParameters();
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    p.encodings[0].maxBitrate = 15_000_000;
    p.encodings[0].maxFramerate = 30;
    p.encodings[0].scaleResolutionDownBy = 1.0;
    if (p.degradationPreference !== undefined) {
      p.degradationPreference = "maintain-resolution";
    }
    sender.setParameters(p).catch(() => {});
  }

  /**
   * Continuously enforce quality every 3 seconds.
   * WebRTC's bandwidth estimator constantly tries to lower quality.
   * We fight back by periodically re-applying our params.
   */
  function startQualityEnforcer(call) {
    stopQualityEnforcer();
    const enforce = () => {
      const pc = call?.peerConnection;
      if (!pc) return;
      applyEncodingParams(pc);
    };
    enforce();
    qualityInterval = setInterval(enforce, 3000);
  }

  function stopQualityEnforcer() {
    if (qualityInterval) { clearInterval(qualityInterval); qualityInterval = null; }
  }

  /* ── Connection ── */

  async function connectToHost() {
    showState("connecting");

    try {
      await loadScript("https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js");
    } catch (_) {
      showState("error", "Failed to load the connection library. Check your internet connection and try again.");
      return;
    }

    peer = new Peer({
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun.relay.metered.ca:80" },
          { urls: "turn:global.relay.metered.ca:80", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" },
          { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" },
          { urls: "turn:global.relay.metered.ca:443", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" },
          { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" }
        ]
      }
    });

    peer.on("open", () => {
      showState("permission");
    });

    peer.on("error", (err) => {
      console.error("PeerJS error:", err);
      if (err.type === "peer-unavailable") {
        showState("error", "The inspection session was not found. It may have expired. Please scan a new QR code.");
      } else if (err.type === "network") {
        showState("error", "Network error. Please check your internet connection and try again.");
      } else {
        showState("error", `Connection error: ${err.message}`);
      }
    });

    peer.on("disconnected", () => {
      if (stateStreaming && !stateStreaming.classList.contains("hidden")) {
        stopStreaming();
        showState("error", "Connection to the session was lost.");
      }
    });
  }

  async function startStreaming() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 3840, min: 1920 },
          height: { ideal: 2160, min: 1080 },
          frameRate: { ideal: 30, min: 24 }
        },
        audio: false
      });

      /* Mark tracks for detail priority */
      stream.getVideoTracks().forEach((t) => {
        if ("contentHint" in t) t.contentHint = "detail";
      });

      /* Log actual resolution obtained */
      const settings = stream.getVideoTracks()[0]?.getSettings();
      console.log(`Camera resolution: ${settings?.width}x${settings?.height} @ ${settings?.frameRate}fps`);

      video.srcObject = stream;
      showState("streaming");

      activeCall = peer.call(hostPeerId, stream);

      /* Patch SDP on the peer connection */
      const pc = activeCall.peerConnection;
      if (pc) patchSdp(pc);

      /* Start continuously enforcing quality params */
      startQualityEnforcer(activeCall);

      activeCall.on("close", () => {
        stopStreaming();
        showState("error", "The inspection session was ended by the host.");
      });

      activeCall.on("error", (err) => {
        console.error("Call error:", err);
        stopStreaming();
        showState("error", "Streaming error. Please try again.");
      });
    } catch (err) {
      console.error("Camera access error:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        showState("error", "Camera permission was denied. Please allow camera access in your browser settings and try again.");
      } else if (err.name === "NotFoundError") {
        showState("error", "No camera found on this device.");
      } else if (err.name === "OverconstrainedError") {
        /* Fallback: retry with looser constraints */
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false
          });
          stream.getVideoTracks().forEach((t) => { if ("contentHint" in t) t.contentHint = "detail"; });
          video.srcObject = stream;
          showState("streaming");
          activeCall = peer.call(hostPeerId, stream);
          const pc = activeCall.peerConnection;
          if (pc) patchSdp(pc);
          startQualityEnforcer(activeCall);
          activeCall.on("close", () => { stopStreaming(); showState("error", "Session ended by host."); });
          activeCall.on("error", () => { stopStreaming(); showState("error", "Streaming error."); });
        } catch (e2) {
          showState("error", "Could not access camera. Please check your device permissions.");
        }
      } else {
        showState("error", "Could not access camera. Please check your device permissions.");
      }
    }
  }

  function stopStreaming() {
    stopQualityEnforcer();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (activeCall) {
      activeCall.close();
      activeCall = null;
    }
    if (video) video.srcObject = null;
  }

  startCameraBtn?.addEventListener("click", startStreaming);

  stopCameraBtn?.addEventListener("click", () => {
    stopStreaming();
    if (peer && !peer.disconnected) {
      showState("permission");
    } else {
      showState("error", "Session disconnected. Scan the QR code again to reconnect.");
    }
  });

  retryBtn?.addEventListener("click", () => {
    if (peer) peer.destroy();
    connectToHost();
  });

  connectToHost();
});
