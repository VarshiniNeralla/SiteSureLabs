/**
 * SiteSureLabs — Hero Spatial Background
 * ─────────────────────────────────────────
 * An AI inspection-field canvas that feels cinematic, intelligent, and spatial.
 *
 * Features:
 *   • Sparse geometric particles (scan markers, grid fragments, structural nodes)
 *   • Three depth layers with parallax tied to cursor
 *   • Gentle magnetic cursor interaction (attraction/repulsion)
 *   • Ultra-slow ambient drift
 *   • Subtle connection lines between nearby particles
 *   • Red/white/gray brand-aligned palette
 *   • 60fps optimized via rAF, visibility API, and low particle count
 *   • Respects prefers-reduced-motion
 */

(function () {
  "use strict";

  /* ── Bail out early ── */
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return;

  const canvas = document.getElementById("hero-spatial-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  /* ── Configuration ── */
  const CFG = {
    // Particle density: particles per 100 000 px²
    density: 0.38,
    minParticles: 28,
    maxParticles: 80,

    // Depth layers
    layers: [
      { speed: 0.12, opacity: 0.10, sizeScale: 0.7, parallax: 0.008 },  // far
      { speed: 0.22, opacity: 0.18, sizeScale: 1.0, parallax: 0.018 },  // mid
      { speed: 0.35, opacity: 0.28, sizeScale: 1.3, parallax: 0.032 },  // near
    ],

    // Cursor interaction
    cursorRadius: 180,
    cursorForce: 0.6,      // gentle magnetic push
    cursorFalloff: 2.2,    // quadratic falloff

    // Connection lines
    connectionDist: 120,
    connectionOpacity: 0.06,

    // Ambient drift
    driftSpeed: 0.15,

    // Brand palette (soft)
    colors: [
      { r: 237, g: 28, b: 36 },    // brand red
      { r: 148, g: 163, b: 184 },   // slate-400
      { r: 100, g: 116, b: 139 },   // slate-500
      { r: 203, g: 213, b: 225 },   // slate-300
      { r: 71,  g: 85,  b: 105 },   // slate-600
      { r: 226, g: 232, b: 240 },   // slate-200
    ],

    // Red probability (keep it rare for accent feel)
    redChance: 0.08,
  };

  /* ── Particle shape types ── */
  const SHAPES = {
    CROSS:     0,  // scan marker +
    DIAMOND:   1,  // ◇ structural node
    BRACKET:   2,  // [ ] coordinate indicator
    DOT_RING:  3,  // ○ with center dot
    TICK:      4,  // small line tick
    GRID_FRAG: 5,  // tiny grid fragment ⊞
  };
  const SHAPE_COUNT = 6;

  /* ── State ── */
  let W = 0, H = 0;
  let dpr = 1;
  let particles = [];
  let mouse = { x: -9999, y: -9999, active: false };
  let animId = null;
  let lastTime = 0;
  let isVisible = true;

  /* ── Resize ── */
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width;
    H = rect.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ── Particle factory ── */
  function createParticle(index, total) {
    const layerIndex = index % CFG.layers.length;
    const layer = CFG.layers[layerIndex];

    const isRed = Math.random() < CFG.redChance;
    const color = isRed
      ? CFG.colors[0]
      : CFG.colors[1 + Math.floor(Math.random() * (CFG.colors.length - 1))];

    const shape = Math.floor(Math.random() * SHAPE_COUNT);
    const baseSize = 2.5 + Math.random() * 3.5;

    // Drift angle — slow, randomized per particle
    const driftAngle = Math.random() * Math.PI * 2;

    return {
      x: Math.random() * W,
      y: Math.random() * H,
      baseX: 0, // set after x
      baseY: 0,
      vx: 0,
      vy: 0,
      size: baseSize * layer.sizeScale,
      shape: shape,
      color: color,
      opacity: layer.opacity * (0.6 + Math.random() * 0.4),
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.003,
      layer: layerIndex,
      layerCfg: layer,
      driftAngle: driftAngle,
      driftPhase: Math.random() * Math.PI * 2,
      // parallax offset (applied from cursor)
      px: 0,
      py: 0,
    };
  }

  function initParticles() {
    const area = W * H;
    let count = Math.round((area / 100000) * CFG.density);
    count = Math.max(CFG.minParticles, Math.min(CFG.maxParticles, count));

    particles = [];
    for (let i = 0; i < count; i++) {
      const p = createParticle(i, count);
      p.baseX = p.x;
      p.baseY = p.y;
      particles.push(p);
    }
  }

  /* ── Draw shapes ── */
  function drawParticle(p) {
    const s = p.size;
    ctx.save();
    ctx.translate(p.x + p.px, p.y + p.py);
    ctx.rotate(p.rotation);
    ctx.globalAlpha = p.opacity;

    const r = p.color.r, g = p.color.g, b = p.color.b;
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = 0.8;

    switch (p.shape) {
      case SHAPES.CROSS:
        // + scan marker
        ctx.beginPath();
        ctx.moveTo(-s, 0); ctx.lineTo(s, 0);
        ctx.moveTo(0, -s); ctx.lineTo(0, s);
        ctx.stroke();
        break;

      case SHAPES.DIAMOND:
        // ◇ rotated square
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.lineTo(s, 0);
        ctx.lineTo(0, s);
        ctx.lineTo(-s, 0);
        ctx.closePath();
        ctx.stroke();
        break;

      case SHAPES.BRACKET:
        // [ ] coordinate brackets
        const bw = s * 0.6;
        const bh = s;
        ctx.beginPath();
        ctx.moveTo(-bw, -bh); ctx.lineTo(-bw - s * 0.4, -bh);
        ctx.lineTo(-bw - s * 0.4, bh); ctx.lineTo(-bw, bh);
        ctx.moveTo(bw, -bh); ctx.lineTo(bw + s * 0.4, -bh);
        ctx.lineTo(bw + s * 0.4, bh); ctx.lineTo(bw, bh);
        ctx.stroke();
        break;

      case SHAPES.DOT_RING:
        // ○ with center dot
        ctx.beginPath();
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.2, 0, Math.PI * 2);
        ctx.fill();
        break;

      case SHAPES.TICK:
        // small angled tick mark
        ctx.beginPath();
        ctx.moveTo(-s * 0.5, s * 0.5);
        ctx.lineTo(0, 0);
        ctx.lineTo(s, -s * 0.8);
        ctx.stroke();
        break;

      case SHAPES.GRID_FRAG:
        // tiny grid fragment
        const gs = s * 0.8;
        ctx.beginPath();
        ctx.strokeRect(-gs, -gs, gs * 2, gs * 2);
        ctx.moveTo(0, -gs); ctx.lineTo(0, gs);
        ctx.moveTo(-gs, 0); ctx.lineTo(gs, 0);
        ctx.stroke();
        break;
    }

    ctx.restore();
  }

  /* ── Connection lines ── */
  function drawConnections() {
    const maxDist = CFG.connectionDist;
    const maxDistSq = maxDist * maxDist;

    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      // Only connect particles on the same or adjacent layers
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        if (Math.abs(a.layer - b.layer) > 1) continue;

        const dx = (a.x + a.px) - (b.x + b.px);
        const dy = (a.y + a.py) - (b.y + b.py);
        const distSq = dx * dx + dy * dy;

        if (distSq < maxDistSq) {
          const dist = Math.sqrt(distSq);
          const alpha = (1 - dist / maxDist) * CFG.connectionOpacity;
          ctx.beginPath();
          ctx.moveTo(a.x + a.px, a.y + a.py);
          ctx.lineTo(b.x + b.px, b.y + b.py);
          ctx.strokeStyle = `rgba(148,163,184,${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  /* ── Update ── */
  function update(dt) {
    const time = lastTime * 0.001;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const layer = p.layerCfg;

      // Ambient drift — ultra-slow sinusoidal wander
      const drift = CFG.driftSpeed * layer.speed;
      p.x += Math.cos(p.driftAngle + time * 0.2 + p.driftPhase) * drift * dt * 0.06;
      p.y += Math.sin(p.driftAngle + time * 0.15 + p.driftPhase) * drift * dt * 0.06;

      // Slow rotation
      p.rotation += p.rotationSpeed * dt;

      // Cursor interaction — gentle magnetic repulsion
      if (mouse.active) {
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const distSq = dx * dx + dy * dy;
        const radius = CFG.cursorRadius;

        if (distSq < radius * radius && distSq > 1) {
          const dist = Math.sqrt(distSq);
          const force = (1 - dist / radius);
          const forceScaled = Math.pow(force, CFG.cursorFalloff) * CFG.cursorForce * layer.speed;
          p.vx += (dx / dist) * forceScaled;
          p.vy += (dy / dist) * forceScaled;
        }

        // Parallax from cursor position (relative to center)
        const cx = (mouse.x - W * 0.5) / W;
        const cy = (mouse.y - H * 0.5) / H;
        p.px = cx * layer.parallax * W;
        p.py = cy * layer.parallax * H;
      } else {
        // Ease parallax back to 0
        p.px *= 0.96;
        p.py *= 0.96;
      }

      // Apply velocity with heavy damping
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;

      // Wrap around edges
      if (p.x < -20) p.x = W + 20;
      if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20;
      if (p.y > H + 20) p.y = -20;
    }
  }

  /* ── Render loop ── */
  function frame(timestamp) {
    if (!isVisible) { animId = null; return; }

    const dt = lastTime ? Math.min(timestamp - lastTime, 50) : 16;
    lastTime = timestamp;

    ctx.clearRect(0, 0, W, H);

    update(dt);

    // Draw connections first (behind particles)
    drawConnections();

    // Draw particles sorted by layer (far → near)
    for (let i = 0; i < particles.length; i++) {
      drawParticle(particles[i]);
    }

    animId = requestAnimationFrame(frame);
  }

  function start() {
    if (animId) return;
    isVisible = true;
    lastTime = 0;
    animId = requestAnimationFrame(frame);
  }

  function stop() {
    isVisible = false;
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }

  /* ── Events ── */
  function onMouseMove(e) {
    const rect = canvas.parentElement.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
    mouse.active = true;
  }

  function onMouseLeave() {
    mouse.active = false;
  }

  function onResize() {
    resize();
    initParticles();
  }

  // Throttled resize
  let resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 200);
  });

  // Cursor tracking on the hero viewport
  const heroViewport = canvas.parentElement;
  heroViewport.addEventListener("mousemove", onMouseMove, { passive: true });
  heroViewport.addEventListener("mouseleave", onMouseLeave, { passive: true });

  // Touch support
  heroViewport.addEventListener("touchmove", function (e) {
    if (e.touches.length > 0) {
      const rect = heroViewport.getBoundingClientRect();
      mouse.x = e.touches[0].clientX - rect.left;
      mouse.y = e.touches[0].clientY - rect.top;
      mouse.active = true;
    }
  }, { passive: true });

  heroViewport.addEventListener("touchend", function () {
    mouse.active = false;
  }, { passive: true });

  // Visibility API — pause when tab hidden
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  /* ── Init ── */
  resize();
  initParticles();
  start();

})();
