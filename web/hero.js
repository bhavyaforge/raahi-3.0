"use strict";

/* =========================================================================
   The road.
   ---------------------------------------------------------------------
   A stretch of asphalt at dawn, running to a vanishing point, with a
   hairline crack opening in the near lane. Drawn procedurally — no image
   files, nothing to download, and it redraws at any size.

   The look is built on one idea: cool shadows against warm light. A scene
   graded entirely in browns reads as muddy no matter how much detail is in
   it. Pushing the sky and the asphalt towards indigo, and keeping amber
   only where the sun actually reaches, is what gives the frame depth.

   On top of that sit the details that separate a diagram from a
   photograph: bloom, light shafts, the sun's reflection running down the
   wet asphalt, dust in the air, a vignette, and a dither pass that kills
   the banding every large gradient otherwise shows.

   It idles when the overview tab is off screen, and holds a single still
   frame for anyone who has asked their system for less motion.
   ========================================================================= */

(function () {
  const canvas = document.getElementById("road");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let width = 0, height = 0, dpr = 1;
  let grain = null, dither = null;
  const buffer = document.createElement("canvas");
  const bctx = buffer.getContext("2d");
  let started = 0, running = false;

  /* ---------- the shape of the road ---------- */
  const HORIZON = 0.52;
  const VANISH = 0.5;
  const NEAR_HALF = 0.70;
  const SUN_X = 0.655;

  const horizonY = () => height * HORIZON;
  const vanishX = () => width * VANISH;
  const depthScale = () => height - horizonY();
  const yAt = (z) => horizonY() + depthScale() / z;
  const halfAt = (z) => (width * NEAR_HALF) / z;
  const sunX = () => width * SUN_X;
  const sunY = () => horizonY() - Math.min(width, height) * 0.030;
  const sunR = () => Math.min(width * 0.040, height * 0.086);

  /* ---------- the crack ---------- */
  // Fixed seed: the same crack every reload, because a crack that moved
  // between visits would be a different crack.
  const crack = (function () {
    let seed = 20260906;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const points = [];
    let u = -0.30;
    for (let i = 0; i <= 60; i++) {
      u += (random() - 0.5) * 0.026;
      points.push({ u, z: 1.02 + i * 0.055 });
    }
    return points;
  })();

  /* ---------- dust in the air ---------- */
  const motes = (function () {
    const out = [];
    for (let i = 0; i < 46; i++) {
      out.push({
        x: Math.random(), y: Math.random(),
        r: 0.4 + Math.random() * 1.5,
        drift: 0.004 + Math.random() * 0.016,
        sway: Math.random() * 6.283,
        alpha: 0.10 + Math.random() * 0.30,
      });
    }
    return out;
  })();

  /* ---------- noise tiles ---------- */
  function buildTile(size, count, spread, alphaLow, alphaHigh) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = size;
    const tx = tile.getContext("2d");
    for (let i = 0; i < count; i++) {
      const lift = Math.random() < 0.5 ? 255 : 0;
      const a = alphaLow + Math.random() * (alphaHigh - alphaLow);
      tx.fillStyle = "rgba(" + lift + "," + lift + "," + lift + "," + a.toFixed(3) + ")";
      tx.fillRect(Math.random() * size, Math.random() * size,
                  Math.random() < 0.82 ? 1 : spread, 1);
    }
    return tile;
  }

  function buildTiles() {
    grain = buildTile(240, 11000, 3, 0.020, 0.115);  // asphalt aggregate
    dither = buildTile(160, 9000, 1, 0.004, 0.016);  // breaks gradient banding
  }

  /* ---------- resize ---------- */
  function resize() {
    const box = canvas.getBoundingClientRect();
    // A hidden tab has no box. Sizing to it would collapse the bitmap to a
    // pixel and every later frame would be that pixel stretched across the
    // hero, so keep the last good size and re-measure on the way back.
    if (box.width < 2 || box.height < 2) return false;

    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.round(box.width);
    height = Math.round(box.height);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buffer.width = width;
    buffer.height = height;
    if (!grain) buildTiles();
    draw(performance.now());
    return true;
  }

  /* ---------- sky ---------- */
  function drawSky() {
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY());
    sky.addColorStop(0.00, "#05060E");     // near-black indigo overhead
    sky.addColorStop(0.30, "#0C1024");
    sky.addColorStop(0.55, "#1E1733");     // violet, where warm meets cool
    sky.addColorStop(0.78, "#4A2436");
    sky.addColorStop(0.92, "#8A3F21");
    sky.addColorStop(1.00, "#C86A25");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, horizonY() + 1);
  }

  function drawStars(time) {
    // Just enough to give the upper sky some depth. Any more and it stops
    // being dawn.
    ctx.save();
    for (let i = 0; i < 34; i++) {
      const x = ((i * 97) % 100) / 100 * width;
      const y = ((i * 61) % 100) / 100 * horizonY() * 0.52;
      const twinkle = 0.35 + 0.3 * Math.sin(time / 1600 + i);
      ctx.fillStyle = "rgba(214,222,255," + (0.16 * twinkle).toFixed(3) + ")";
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.restore();
  }

  /* ---------- sun ---------- */
  function drawGodRays(time) {
    // Shafts through the haze. Each one is drawn twice — a wide soft wedge
    // and a narrow brighter core — because a single hard-edged triangle
    // reads as a drawn ray rather than as light in air. Clipped to the sky:
    // a shaft crossing the tarmac would give the game away instantly.
    const cx = sunX(), cy = sunY(), reach = Math.max(width, height) * 1.2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, horizonY());
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(cx, cy);
    for (let i = 0; i < 11; i++) {
      const base = -2.05 + i * 0.29;
      const angle = base + Math.sin(time / 9000 + i * 1.7) * 0.06;
      for (const pass of [{ w: 0.22, a: 0.011 }, { w: 0.07, a: 0.013 }]) {
        const spread = pass.w * (0.85 + 0.3 * Math.sin(time / 6000 + i));
        const shaft = ctx.createLinearGradient(0, 0,
          Math.cos(angle) * reach, Math.sin(angle) * reach);
        shaft.addColorStop(0, "rgba(255,196,124," + pass.a + ")");
        shaft.addColorStop(0.30, "rgba(255,168,96," + (pass.a * 0.55).toFixed(4) + ")");
        shaft.addColorStop(1, "rgba(255,140,60,0)");
        ctx.fillStyle = shaft;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(angle - spread) * reach, Math.sin(angle - spread) * reach);
        ctx.lineTo(Math.cos(angle + spread) * reach, Math.sin(angle + spread) * reach);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawSun(time) {
    const breathe = 1 + Math.sin(time / 3600) * 0.018;
    const cx = sunX(), cy = sunY(), radius = sunR() * breathe;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Bloom, in two passes: a wide warm wash and a tight bright core.
    const wash = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius * 9);
    wash.addColorStop(0, "rgba(255,170,80,0.26)");
    wash.addColorStop(0.28, "rgba(226,110,45,0.10)");
    wash.addColorStop(1, "rgba(120,40,20,0)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, width, height);

    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 2.6);
    core.addColorStop(0, "rgba(255,236,200,0.55)");
    core.addColorStop(0.4, "rgba(255,180,96,0.22)");
    core.addColorStop(1, "rgba(255,150,70,0)");
    ctx.fillStyle = core;
    ctx.fillRect(cx - radius * 3, cy - radius * 3, radius * 6, radius * 6);
    ctx.restore();

    const disc = ctx.createRadialGradient(cx, cy - radius * 0.22, 0, cx, cy, radius);
    disc.addColorStop(0.00, "#FFE9C6");
    disc.addColorStop(0.42, "#FFC578");
    disc.addColorStop(0.82, "rgba(240,140,54,0.94)");
    disc.addColorStop(1.00, "rgba(214,104,36,0)");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 6.283);
    ctx.fill();
  }

  /* ---------- ground and road ---------- */
  function drawGround() {
    // Verge either side. Without it the road hangs in the dark and the
    // horizon reads as a ruled line rather than as distance.
    const y1 = horizonY();
    const earth = ctx.createLinearGradient(0, y1, 0, height);
    earth.addColorStop(0.00, "#9A5A32");     // meets the sky's own colour
    earth.addColorStop(0.02, "#6B4238");
    earth.addColorStop(0.06, "#3A2A3A");
    earth.addColorStop(0.16, "#191629");
    earth.addColorStop(0.46, "#0C0C16");
    earth.addColorStop(1.00, "#06060C");
    ctx.fillStyle = earth;
    ctx.fillRect(0, y1, width, height - y1);

    // Warmth spilling onto the ground where the sun actually is, so the
    // horizon stops being a ruled line drawn across the frame.
    const spill = ctx.createRadialGradient(sunX(), y1, 0, sunX(), y1, width * 0.55);
    spill.addColorStop(0.00, "rgba(228,132,58,0.42)");
    spill.addColorStop(0.34, "rgba(150,78,48,0.15)");
    spill.addColorStop(1.00, "rgba(80,50,60,0)");
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y1, width, height - y1);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = spill;
    ctx.fillRect(0, y1, width, height - y1);
    ctx.restore();
  }

  function roadPath() {
    ctx.beginPath();
    ctx.moveTo(vanishX() - halfAt(1), height);
    ctx.lineTo(vanishX() + halfAt(1), height);
    ctx.lineTo(vanishX() + halfAt(160), horizonY());
    ctx.lineTo(vanishX() - halfAt(160), horizonY());
    ctx.closePath();
  }

  function drawRoad(time) {
    const y0 = height, y1 = horizonY();
    roadPath();

    // Cool asphalt. The warmth arrives separately, only where light lands.
    const surface = ctx.createLinearGradient(0, y1, 0, y0);
    surface.addColorStop(0.00, "#6E5A4E");
    surface.addColorStop(0.09, "#3B3340");
    surface.addColorStop(0.34, "#20202F");
    surface.addColorStop(0.70, "#14141F");
    surface.addColorStop(1.00, "#0C0C14");
    ctx.fillStyle = surface;
    ctx.fill();

    ctx.save();
    roadPath();
    ctx.clip();

    if (grain) {
      // Twice: once flat for the shadowed tarmac, once in "lighter" so the
      // aggregate actually catches the low sun. Chippings are what stop a
      // road looking like a painted ramp.
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = ctx.createPattern(grain, "repeat");
      ctx.fillRect(0, y1, width, y0 - y1);

      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.30;
      ctx.fillRect(0, y1, width, (y0 - y1) * 0.55);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    // The sun's reflection running down the asphalt — the detail that makes
    // a surface read as a surface rather than as a fill.
    drawReflection(time);

    // Light raking in from the sun's side.
    ctx.globalCompositeOperation = "lighter";
    const rake = ctx.createLinearGradient(width, y1, width * 0.12, y0);
    rake.addColorStop(0, "rgba(255,164,84,0.10)");
    rake.addColorStop(0.55, "rgba(180,110,70,0.03)");
    rake.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rake;
    ctx.fillRect(0, y1, width, y0 - y1);
    ctx.restore();
  }

  function drawReflection(time) {
    // Drawn on a buffer as one smooth vertical gradient, then masked
    // sideways with destination-in. Stacking horizontal bands instead —
    // the obvious approach — leaves a visible ladder of bars down the road,
    // because each band has an edge and the eye finds every one of them.
    const cx = sunX(), y1 = horizonY();
    bctx.clearRect(0, 0, width, height);

    const down = bctx.createLinearGradient(0, y1, 0, height);
    down.addColorStop(0.00, "rgba(255,206,142,0.46)");
    down.addColorStop(0.14, "rgba(255,176,96,0.26)");
    down.addColorStop(0.44, "rgba(226,124,56,0.10)");
    down.addColorStop(0.78, "rgba(180,84,40,0.03)");
    down.addColorStop(1.00, "rgba(150,64,28,0)");
    bctx.fillStyle = down;
    bctx.fillRect(0, y1, width, height - y1);

    // Sideways falloff, widening towards the viewer the way a reflection
    // spreads on a surface that is rough close up and flat at distance.
    bctx.globalCompositeOperation = "destination-in";
    const steps = 64;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const yTop = y1 + (height - y1) * t;
      const yBot = y1 + (height - y1) * ((i + 1) / (steps - 1)) + 1;
      const w = width * (0.022 + 0.30 * Math.pow(t, 1.15));
      const mask = bctx.createLinearGradient(cx - w, 0, cx + w, 0);
      mask.addColorStop(0.00, "rgba(0,0,0,0)");
      mask.addColorStop(0.30, "rgba(0,0,0,0.35)");
      mask.addColorStop(0.50, "rgba(0,0,0,1)");
      mask.addColorStop(0.70, "rgba(0,0,0,0.35)");
      mask.addColorStop(1.00, "rgba(0,0,0,0)");
      bctx.fillStyle = mask;
      bctx.fillRect(cx - w, yTop, w * 2, yBot - yTop);
    }
    bctx.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(buffer, 0, 0);

    // A slow swell along its length, so it breathes instead of sitting still.
    if (!still) {
      for (let i = 0; i < 9; i++) {
        const t = (i / 9 + (time / 9000) % 1) % 1;
        const y = y1 + (height - y1) * t;
        const w = width * (0.022 + 0.30 * Math.pow(t, 1.15));
        const swell = ctx.createLinearGradient(cx - w, 0, cx + w, 0);
        const a = 0.030 * (1 - t);
        swell.addColorStop(0, "rgba(255,214,158,0)");
        swell.addColorStop(0.5, "rgba(255,214,158," + a.toFixed(4) + ")");
        swell.addColorStop(1, "rgba(255,214,158,0)");
        ctx.fillStyle = swell;
        ctx.fillRect(cx - w, y, w * 2, (height - y1) * 0.06);
      }
    }
    ctx.restore();
  }

  function drawEdges() {
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      for (let z = 1; z < 140; z *= 1.055) {
        const x = vanishX() + side * (halfAt(z) * 0.94);
        const y = yAt(z);
        if (z === 1) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(236,214,176,0.17)";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  function drawLaneDashes(time) {
    const phase = still ? 0 : (time / 1150) % 2.4;
    for (let i = 0; i < 48; i++) {
      let near = 1 + i * 2.4 - phase;
      const far = near + 1.25;
      // A dash straddling the bottom edge gets clipped to it rather than
      // dropped — otherwise the foreground goes blank once per cycle.
      if (far <= 1) continue;
      if (near < 1) near = 1;
      const yNear = yAt(near), yFar = yAt(far);
      if (yNear - yFar < 0.35) break;
      const wNear = halfAt(near) * 0.017 + 0.4;
      const wFar = halfAt(far) * 0.017 + 0.3;
      ctx.globalAlpha = Math.max(0, Math.min(1, (near - 1) / 3.5)) * 0.82;
      ctx.fillStyle = "rgba(244,230,200,0.62)";
      ctx.beginPath();
      ctx.moveTo(vanishX() - wNear, yNear);
      ctx.lineTo(vanishX() + wNear, yNear);
      ctx.lineTo(vanishX() + wFar, yFar);
      ctx.lineTo(vanishX() - wFar, yFar);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- the crack ---------- */
  const crackPoint = (p) => ({ x: vanishX() + p.u * halfAt(p.z), y: yAt(p.z) });

  function strokeCrack(upTo, colour, weight, offsetY) {
    // Segment by segment, so the stroke narrows with distance. One
    // constant-width line across a perspective view reads as a drawn mark;
    // this reads as something in the road.
    const last = Math.max(1, Math.floor((crack.length - 1) * upTo));
    for (let i = 0; i < last; i++) {
      const a = crackPoint(crack[i]), b = crackPoint(crack[i + 1]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y + (offsetY || 0));
      ctx.lineTo(b.x, b.y + (offsetY || 0));
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.max(0.6, weight / crack[i].z);
      ctx.stroke();
    }
  }

  function drawCrack(time) {
    const age = still ? 1 : Math.min(1, (time - started) / 2200);
    const progress = 1 - Math.pow(1 - age, 3);
    if (progress <= 0.02) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // A lit lip on the sun side, then the dark interior. That pair is what
    // makes it read as depth rather than as a stroke on glass.
    strokeCrack(progress, "rgba(255,206,150,0.30)", 10, -1.4);
    strokeCrack(progress, "rgba(96,74,62,0.34)", 7.5, 0.5);
    strokeCrack(progress, "#08080C", 5.4, 0);
    ctx.restore();
  }

  /* ---------- air and finish ---------- */
  function drawHaze() {
    const cx = sunX(), cy = horizonY();
    const pool = ctx.createRadialGradient(cx, cy, 0, cx, cy, width * 0.70);
    pool.addColorStop(0.00, "rgba(226,132,52,0.34)");
    pool.addColorStop(0.30, "rgba(160,80,44,0.13)");
    pool.addColorStop(1.00, "rgba(60,40,70,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Cool fog sitting on the far distance, so depth reads as air and not
    // just as a smaller road.
    const top = horizonY() - height * 0.085;
    const fog = ctx.createLinearGradient(0, top, 0, horizonY() + height * 0.15);
    fog.addColorStop(0.00, "rgba(112,98,142,0)");
    fog.addColorStop(0.40, "rgba(120,102,140,0.20)");
    fog.addColorStop(0.52, "rgba(126,104,132,0.26)");
    fog.addColorStop(1.00, "rgba(96,86,132,0)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, top, width, height * 0.24);
  }

  function drawMotes(time) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const m of motes) {
      const t = still ? 0 : time / 1000;
      const x = ((m.x + Math.sin(t * 0.12 + m.sway) * 0.02) % 1 + 1) % 1 * width;
      const y = ((m.y - t * m.drift * 0.02) % 1 + 1) % 1 * height;
      const near = Math.abs(x - sunX()) / width;
      const lit = Math.max(0, 1 - near * 1.6);
      ctx.fillStyle = "rgba(255,206,150," + (m.alpha * (0.25 + lit * 0.75)).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(x, y, m.r, 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFinish() {
    // Vignette: warmer where the light is, cool everywhere else.
    const vignette = ctx.createRadialGradient(
      sunX(), horizonY(), Math.min(width, height) * 0.18,
      width * 0.5, height * 0.55, Math.max(width, height) * 0.82);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(0.62, "rgba(6,6,12,0.20)");
    vignette.addColorStop(1, "rgba(4,4,9,0.72)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    // Dither. Large smooth gradients band on 8-bit displays; a whisper of
    // noise over the top is what stops the sky showing stripes.
    if (dither) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = ctx.createPattern(dither, "repeat");
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
  }

  /* ---------- frame ---------- */
  function draw(time) {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    drawSky();
    drawStars(time);
    drawGodRays(time);
    drawSun(time);
    drawGround();
    drawRoad(time);
    drawEdges();
    drawLaneDashes(time);
    drawHaze();
    drawCrack(time);
    drawMotes(time);
    drawFinish();
  }

  function frame(time) {
    if (!running) return;
    draw(time);
    requestAnimationFrame(frame);
  }

  function shouldRun() {
    const page = document.getElementById("p0");
    return !still && document.visibilityState === "visible" &&
           page && page.classList.contains("on");
  }

  function sync() {
    // The window may have changed size while this tab was hidden.
    const box = canvas.getBoundingClientRect();
    if (box.width >= 2 && Math.abs(box.width - width) > 1) resize();

    const want = shouldRun();
    if (want && !running) {
      running = true;
      requestAnimationFrame(frame);
    } else if (!want) {
      running = false;
      if (!still) draw(performance.now());
    }
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", sync);

  started = performance.now();
  resize();
  sync();

  window.RoadHero = { sync: sync };
})();
