"use strict";

/* =========================================================================
   The street.
   ---------------------------------------------------------------------
   A city road at first light, seen from the height of a survey vehicle's
   windscreen, moving slowly forward. Buildings stand on both sides, the
   tarmac scrolls underneath, and cracks open in the surface ahead and pass
   beneath the camera — which is the thing the whole product is about.

   Everything is drawn procedurally. No image files, no textures to
   download, no libraries; it redraws at any size and on any pixel ratio.

   HOW THE SCENE IS BUILT

   One vanishing point, one ground plane, and a single unit system. A world
   point is three numbers:

       u   sideways, in units of the road's half width  (u = 1 is the kerb)
       h   upwards,  in the same units
       z   distance from the camera

   and projects with a single scale factor, k = halfAt(z):

       x = vanish + u*k          y = ground(z) - h*k

   Because the same k does both axes, a box in the world is four quads on
   the screen and nothing needs a matrix. Straight lines stay straight, so
   every face is a plain four-point path.

   Forward motion is one number, `travel`. Anything standing on the ground
   is stored at a fixed world distance s and drawn at z = s - travel; when
   it passes the camera it is rebuilt far away. That is what makes the
   cracks arrive, open, run past, and be replaced by new ones.

   WHAT MAKES IT READ AS A PHOTOGRAPH RATHER THAN A DRAWING

   - Backlight. The sun is at the end of the street, so the buildings are
     silhouettes with light wrapping their edges. Nothing is lit flatly
     from the front, which is what makes computer-generated streets look
     like toys.
   - Aerial perspective. Distance is not just smaller; it is washed toward
     the colour of the air. Every facade, window and crack is mixed toward
     the haze by its own depth.
   - Nothing repeats. Heights, widths, setbacks, window grids, which lamp
     is out, which flat has its light on — all from a seeded generator, so
     the street is irregular but identical on every reload.
   - Grain, bloom, dither and a vignette on top, because a clean gradient
     is the one thing a camera never produces.

   It idles when the overview tab is off screen, and holds a single still
   frame for anyone who has asked their system for less motion.
   ========================================================================= */

(function () {
  const canvas = document.getElementById("road");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let width = 0, height = 0, dpr = 1;
  let grain = null, dither = null, concrete = null;
  let grainPat = null, ditherPat = null, concretePat = null;
  const buffer = document.createElement("canvas");
  const bctx = buffer.getContext("2d");
  // The sun's reflection down the road never changes shape between
  // resizes, so it is rendered once and blitted. Rebuilding it every
  // frame — sixty-four gradient fills across a full-size canvas — was
  // ninety-five per cent of the frame budget and bought nothing.
  let sheen = null;
  let running = false, lastFrame = 0, travel = 0;

  // Adaptive detail. The scene is drawn for a machine that can afford it;
  // on one that cannot, the honest thing is to drop the parts nobody will
  // miss rather than to stutter. `rich` gates the expensive extras —
  // plaster blotching, weathering, facade fixtures, dense foliage — and
  // it moves slowly, so it never flickers on and off frame to frame.
  let budget = 16, rich = true;

  /* ---------------------------------------------------------------- shape */

  const HORIZON = 0.505;   // where the ground plane meets the sky
  const VANISH = 0.5;      // the street runs straight away from us
  const NEAR_HALF = 0.52;  // half the carriageway, as a fraction of the frame
  const SUN_X = 0.545;     // just off the vanishing point, so it sits in the gap

  /* ------------------------------------------------------------ camera */

  // A camera bolted to a tripod pointing down a street is the one thing
  // that never happens in real footage. The projection below was already
  // true perspective, and the scene still read as a flat picture sliding
  // upwards, because nothing in it moved the way a camera does.
  //
  // Six numbers fix that, and they have to be physically consistent or the
  // brain rejects the whole thing:
  //
  //   bob    the camera rises and falls on the suspension. The horizon is
  //          at infinity, so raising the camera does NOT move it — it makes
  //          the ground fall away faster. That is depthScale, not horizonY.
  //   pitch  the nose lifts and drops. This DOES move the horizon, because
  //          the horizon's position depends on where the camera is pointed
  //          and not on where it is.
  //   sway   the vehicle drifts across its lane. A lateral shift moves
  //          near things a lot and far things not at all — which is
  //          parallax, and parallax is the whole of the 3D read.
  //   yaw    the driver corrects. This moves the vanishing point, and the
  //          sun with it, since both are at infinity.
  //   roll   the body leans into the correction.
  //
  // Every axis is the sum of three incommensurate sines, so the motion
  // never visibly repeats and never looks like a loop.
  let camBob = 0, camPitch = 0, camSway = 0, camYaw = 0, camRoll = 0;

  function updateCamera(time) {
    if (still) { camBob = camPitch = camSway = camYaw = camRoll = 0; return; }
    const t = time / 1000;
    // Suspension. A loaded vehicle body bounces at somewhere near 1.5 Hz;
    // anything much slower reads as swimming rather than as driving, which
    // is what the first attempt at this looked like.
    camBob = Math.sin(t * 8.4) * 0.009 + Math.sin(t * 13.1 + 1.1) * 0.004
           + Math.sin(t * 2.3 + 2.3) * 0.011;
    // Pitch trails the bob, the way a body does over its springs.
    camPitch = Math.sin(t * 8.4 - 0.55) * 0.0015 + Math.sin(t * 2.3 + 1.7) * 0.0015;
    // Lane wander and the corrections that go with it.
    camSway = Math.sin(t * 0.41) * 0.055 + Math.sin(t * 0.97 + 0.7) * 0.020;
    camYaw = Math.sin(t * 0.41 + 1.57) * 0.0034 + Math.sin(t * 0.97 + 2.3) * 0.0012;
    camRoll = Math.sin(t * 0.41 + 1.2) * 0.0042 + Math.sin(t * 1.13 + 2.2) * 0.0018;
  }

  const horizonY = () => height * (HORIZON + camPitch);
  const vanishX = () => width * (VANISH + camYaw);
  // Bob changes how fast the ground falls away, because that is the one
  // thing camera height actually controls.
  const depthScale = () => height * (1 - HORIZON) * (1 + camBob);
  const yAt = (z) => horizonY() + depthScale() / z;
  const halfAt = (z) => (width * NEAR_HALF) / z;
  const sunX = () => width * (SUN_X + camYaw);
  const sunY = () => horizonY() - Math.min(width, height) * 0.042;
  const sunR = () => Math.min(width * 0.032, height * 0.070);

  // The one projection. Everything in the world goes through it.
  const P = (u, h, z) => {
    const k = halfAt(z);
    return { x: vanishX() + (u - camSway) * k, y: yAt(z) - h * k };
  };

  function quad(a, b, c, d) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  function addQuad(path, a, b, c, d) {
    path.moveTo(a.x, a.y); path.lineTo(b.x, b.y);
    path.lineTo(c.x, c.y); path.lineTo(d.x, d.y);
    path.closePath();
  }

  /* ------------------------------------------------------------ the air */

  // Aerial perspective. Two colours, because the air near the sun is warm
  // and the air away from it is not; a single grey haze is the giveaway
  // that a scene was assembled rather than photographed.
  const HAZE_COOL = [62, 58, 86];
  const HAZE_WARM = [124, 96, 84];

  function fogOf(z) {
    // Deliberately slow to start. Haze that begins at the kerb turns every
    // near surface into pastel, which is the single most common way a
    // generated street gives itself away.
    const t = (z - 5) / 58;
    return Math.max(0, Math.min(0.82, Math.pow(Math.max(0, t), 0.85)));
  }

  function hazeAt(screenX) {
    const near = 1 - Math.min(1, Math.abs(screenX - sunX()) / (width * 0.62));
    const w = Math.pow(near, 1.6);
    return [
      HAZE_COOL[0] + (HAZE_WARM[0] - HAZE_COOL[0]) * w,
      HAZE_COOL[1] + (HAZE_WARM[1] - HAZE_COOL[1]) * w,
      HAZE_COOL[2] + (HAZE_WARM[2] - HAZE_COOL[2]) * w,
    ];
  }

  function veil(rgb, screenX, fog, alpha) {
    const h = hazeAt(screenX);
    const r = Math.round(rgb[0] + (h[0] - rgb[0]) * fog);
    const g = Math.round(rgb[1] + (h[1] - rgb[1]) * fog);
    const b = Math.round(rgb[2] + (h[2] - rgb[2]) * fog);
    return "rgba(" + r + "," + g + "," + b + "," + (alpha === undefined ? 1 : alpha) + ")";
  }

  /* --------------------------------------------------------------- seeds */

  // Deterministic, so the street is the same street on every visit. A city
  // that reshuffles itself on reload is a screensaver, not a place.
  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rngL = seeded(0x5A17E1), rngR = seeded(0x2026C7), rngC = seeded(0x9F0D33);

  // Stateless randomness for anything placed by index rather than stored:
  // which lamp is out, where a tree stands, where the road was patched.
  function hash(i, salt) {
    let t = (Math.imul(i + 1, 2654435761) ^ Math.imul(salt | 0, 1597334677)) >>> 0;
    t ^= t >>> 15; t = Math.imul(t, 2246822519);
    t ^= t >>> 13; t = Math.imul(t, 3266489917);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  }

  /* ----------------------------------------------------------- buildings */

  const CITY_FAR = 86;      // build out to here and no further
  const STOREY_LO = 0.55, STOREY_HI = 0.68;

  // Facade families. Real streets are not one material, and the eye reads
  // the mixture long before it reads any single building.
  const SKINS = [
    { base: [17, 16, 22], top: [33, 30, 39] },   // grey concrete
    { base: [23, 17, 17], top: [42, 31, 28] },   // brick / plaster
    { base: [15, 17, 24], top: [29, 33, 44] },   // blue-grey
    { base: [21, 20, 18], top: [38, 35, 30] },   // sandy plaster
  ];

  function makeBuilding(rng, side, s0) {
    const roll = rng();
    const kind = roll < 0.15 ? "tower" : roll < 0.42 ? "shop" : "block";

    const depth = kind === "tower" ? 1.5 + rng() * 1.3
                : kind === "shop" ? 0.75 + rng() * 1.0
                : 1.15 + rng() * 1.9;
    const storeys = kind === "tower" ? 6 + (rng() * 5 | 0)
                  : kind === "shop" ? 1 + (rng() * 2 | 0)
                  : 2 + (rng() * 4 | 0);
    const storeyH = STOREY_LO + rng() * (STOREY_HI - STOREY_LO);
    const body = storeys * storeyH;
    const parapet = 0.06 + rng() * 0.12;
    const inset = 1.98 + rng() * 0.72;
    const girth = 0.9 + rng() * 2.6;
    const skin = SKINS[(rng() * SKINS.length) | 0];

    // How much of this block is awake. Whole buildings differ — an office
    // is dark at dawn and a housing block is half lit — and that variation
    // between buildings is what stops the window grid reading as a texture.
    const occupancy = kind === "tower" ? 0.10 + rng() * 0.22
                    : kind === "shop" ? 0.30 + rng() * 0.35
                    : 0.16 + rng() * 0.34;
    const coolBias = kind === "tower" ? 0.62 : 0.24;   // offices run fluorescent

    const cols = Math.max(2, Math.round(depth / (kind === "tower" ? 0.26 : 0.34)));
    const rows = storeys;

    // Which columns actually carry windows. A wall with an unbroken grid
    // of identical openings edge to edge is wallpaper; real facades have a
    // solid pier at each end, a stair core somewhere, and a blank bay
    // wherever the plan needed one.
    const blank = [];
    for (let c = 0; c < cols; c++) {
      blank.push(c === 0 || c === cols - 1 ? rng() < 0.75 : rng() < 0.14);
    }

    const cells = [];
    for (let r = 0; r < rows; r++) {
      // A dark floor here and there: nobody is up on the third floor.
      const floorDim = rng() < 0.18 ? 0.15 : 1;
      for (let c = 0; c < cols; c++) {
        if (blank[c]) continue;
        const on = rng() < occupancy * floorDim;
        cells.push({
          r: r, c: c,
          lit: !on ? 0 : (rng() < coolBias ? 2 : 1),
          a: 0.45 + rng() * 0.55,
          flick: rng() < 0.05 ? 3 + rng() * 5 : 0,
        });
      }
    }

    // Roof furniture. Water tanks and a hoarding are what make an Indian
    // skyline that skyline, and they break the flat parapet line that
    // otherwise gives a generated building away instantly.
    const roof = [];
    const tanks = kind === "tower" ? 0 : 1 + (rng() * 3 | 0);
    for (let i = 0; i < tanks; i++) {
      roof.push({
        t: "tank",
        u: 0.12 + rng() * 0.72,
        s: 0.18 + rng() * 0.6,
        w: 0.11 + rng() * 0.09,
        h: 0.13 + rng() * 0.10,
      });
    }
    const board = rng() < (kind === "shop" ? 0.45 : 0.22);
    if (board) {
      roof.push({
        t: "board",
        u: 0.08 + rng() * 0.3,
        w: 0.45 + rng() * 0.4,
        h: 0.30 + rng() * 0.22,
        warm: rng() < 0.88,
      });
    }
    if (kind === "tower") roof.push({ t: "mast", u: 0.3 + rng() * 0.4, h: 0.30 + rng() * 0.3 });

    return {
      kind: kind, side: side,
      s0: s0, s1: s0 + depth, depth: depth,
      uIn: inset * side, uOut: (inset + girth) * side,
      inset: inset, girth: girth,
      storeys: storeys, storeyH: storeyH, body: body,
      h: body + parapet, parapet: parapet,
      skin: skin, cols: cols, rows: rows, cells: cells, roof: roof,
      // Shop signage: a lit band over the shutters.
      sign: kind === "shop" ? { warm: rng() < 0.88, a: 0.45 + rng() * 0.45 } : null,
      // Balconies. A flat wall with holes in it is a diagram; the ledges,
      // the railings and the shadow each one throws are what make a facade
      // read as a building somebody lives in.
      balcony: kind === "block" && rng() < 0.62,
    };
  }

  function makeSide(rng, side) {
    const list = [];
    let s = 2.6;
    while (s < CITY_FAR) {
      const b = makeBuilding(rng, side, s);
      list.push(b);
      // Gaps: alleys, a plot nobody built on, a compound wall.
      s = b.s1 + (rng() < 0.16 ? 0.5 + rng() * 1.4 : 0.04 + rng() * 0.14);
    }
    return list;
  }

  let cityL = makeSide(rngL, -1), cityR = makeSide(rngR, 1);

  function recycleCity() {
    [[cityL, rngL, -1], [cityR, rngR, 1]].forEach(function (pair) {
      const list = pair[0], rng = pair[1], side = pair[2];
      while (list.length && list[0].s1 - travel < 0.75) list.shift();
      let last = list.length ? list[list.length - 1].s1 : travel + 3;
      while (last - travel < CITY_FAR) {
        const gap = rng() < 0.16 ? 0.5 + rng() * 1.4 : 0.04 + rng() * 0.14;
        const b = makeBuilding(rng, side, last + gap);
        list.push(b);
        last = b.s1;
      }
    });
  }

  /* -------------------------------------------------------- street lamps */

  const LAMP_GAP = 6.4, LAMP_H = 1.42, LAMP_U = 1.14;

  function lampsInView() {
    const out = [];
    const first = Math.ceil((travel + 1.0) / LAMP_GAP);
    for (let i = first; i < first + 26; i++) {
      const s = i * LAMP_GAP;
      const z = s - travel;
      if (z > CITY_FAR) break;
      // Staggered sides, and roughly one lamp in nine is out — because on a
      // real road roughly one lamp in nine is out.
      const side = (i % 2 === 0) ? 1 : -1;
      out.push({ z: z, side: side, on: (i * 2654435761 % 9) !== 0, i: i });
    }
    return out;
  }

  /* -------------------------------------------------------------- cracks */

  // A crack is a spine of world points plus a half-width profile, so it can
  // taper to nothing at both tips. Stroking a constant-width line would
  // read as a mark on glass; a filled shape that narrows to a point reads
  // as a fissure in a surface.
  function makeCrack(rng, s0) {
    const u0 = (rng() - 0.5) * 1.45;
    const run = 2.4 + rng() * 5.2;
    const steps = 40 + (rng() * 26 | 0);
    const bias = (rng() - 0.5) * 0.10;
    const spine = [];
    let u = u0, s = s0, drift = 0;
    for (let i = 0; i <= steps; i++) {
      spine.push({ u: u, s: s });
      // Asphalt does not curve. It fails along whichever weakness is
      // nearest, so a crack runs almost straight and then turns sharply —
      // and it is the sharp turns, not the wander, that the eye reads as
      // fracture rather than as a drawn line.
      if (rng() < 0.16) drift = (rng() - 0.5) * 0.14;
      else drift = drift * 0.90 + (rng() - 0.5) * 0.012;
      u += drift * 0.5 + bias * 0.04;
      s += run / steps;
    }

    // Width, with pinch points. A real crack is not a ribbon of even
    // thickness: it opens, nearly closes, and opens again, and those near
    // closures are what break it up into something that looks broken.
    const wid = [];
    let pinch = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const shape = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.78)), 0.85);
      if (rng() < 0.10) pinch = 0.10 + rng() * 0.22;
      pinch = pinch * 0.62 + (1 - 0.62) * (0.55 + rng() * 0.75);
      wid.push((0.0030 + 0.0128 * shape) * Math.min(1.6, pinch));
    }

    // Spurs. A crack that has been open a while sheds short branches, and
    // they are the difference between a crack and a scratch.
    const spurs = [];
    const nSpurs = 3 + (rng() * 5 | 0);
    for (let i = 0; i < nSpurs; i++) {
      const at = 3 + (rng() * (steps - 6) | 0);
      const dir = rng() < 0.5 ? -1 : 1;
      const len = 3 + (rng() * 7 | 0);
      const pts = [];
      let su = spine[at].u, ss = spine[at].s, d = dir * (0.02 + rng() * 0.05);
      for (let j = 0; j <= len; j++) {
        pts.push({ u: su, s: ss });
        su += d; ss += (rng() - 0.35) * 0.08;
        d = d * 0.86 + (rng() - 0.5) * 0.024;
      }
      spurs.push(pts);
    }

    return {
      spine: spine, wid: wid, spurs: spurs,
      s0: s0, s1: s, run: run,
      // Opens when its middle reaches this depth: far enough away that you
      // watch it happen, near enough that you can see what it is.
      trigger: 13 + rng() * 7,
      open: 0, opening: false,
      // A patch of map cracking round some of them.
      web: rng() < 0.45 ? Math.floor(steps * (0.3 + rng() * 0.4)) : -1,
      len_mm: Math.round((run * 4500) * (0.06 + rng() * 0.05)),
    };
  }

  function seedCracks() {
    const out = [];
    // Enough of them that the near lane is rarely empty. This is a hero
    // for a crack-measuring tool; a frame with no crack in it is a frame
    // that says nothing.
    let s = 2.5;
    for (let i = 0; i < 15; i++) {
      out.push(makeCrack(rngC, s));
      s += 3.6 + rngC() * 5.2;
    }
    return out;
  }

  let cracks = seedCracks();

  function recycleCracks() {
    for (let i = 0; i < cracks.length; i++) {
      const c = cracks[i];
      if (c.s1 - travel < 0.7) {
        // Put it back at the far end, staggered, so they keep arriving
        // rather than turning up in a convoy.
        let far = travel + 26;
        for (const other of cracks) far = Math.max(far, other.s1);
        cracks[i] = makeCrack(rngC, far + 2.2 + rngC() * 5.4);
      }
    }
  }

  /* --------------------------------------------------------- noise tiles */

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
    grain = buildTile(240, 11000, 3, 0.020, 0.115);   // asphalt aggregate
    dither = buildTile(160, 9000, 1, 0.004, 0.016);   // breaks gradient banding
    concrete = buildTile(120, 2600, 2, 0.010, 0.055); // facade tooth
    // Patterns are objects, not styles. Making a new one every frame for
    // every fill is pure waste; they are immutable once the tile exists.
    grainPat = ctx.createPattern(grain, "repeat");
    ditherPat = ctx.createPattern(dither, "repeat");
    concretePat = ctx.createPattern(concrete, "repeat");
  }

  function buildSheen() {
    // Pre-rendered, so it has to be built from the camera's rest pose;
    // otherwise whatever the suspension happened to be doing at resize
    // would be baked into it for good.
    const kb = camBob, kp = camPitch, ky = camYaw;
    camBob = camPitch = camYaw = 0;
    // One smooth vertical gradient, masked sideways with destination-in.
    // Stacking horizontal bands instead — the obvious approach — leaves a
    // visible ladder of bars down the road, because each band has an edge
    // and the eye finds every one of them.
    const cx = sunX(), y1 = horizonY();
    bctx.clearRect(0, 0, width, height);

    const down = bctx.createLinearGradient(0, y1, 0, height);
    down.addColorStop(0.00, "rgba(255,206,142,0.42)");
    down.addColorStop(0.14, "rgba(255,176,96,0.23)");
    down.addColorStop(0.44, "rgba(226,124,56,0.09)");
    down.addColorStop(0.78, "rgba(180,84,40,0.03)");
    down.addColorStop(1.00, "rgba(150,64,28,0)");
    bctx.fillStyle = down;
    bctx.fillRect(0, y1, width, height - y1);

    bctx.globalCompositeOperation = "destination-in";
    const steps = 64;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const yTop = y1 + (height - y1) * t;
      const yBot = y1 + (height - y1) * ((i + 1) / (steps - 1)) + 1;
      const w = width * (0.020 + 0.26 * Math.pow(t, 1.15));
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

    sheen = document.createElement("canvas");
    sheen.width = width; sheen.height = height;
    sheen.getContext("2d").drawImage(buffer, 0, 0);
    camBob = kb; camPitch = kp; camYaw = ky;
  }

  /* -------------------------------------------------------------- resize */

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
    buildSheen();
    draw();
    return true;
  }

  /* ----------------------------------------------------------------- sky */

  function drawSky() {
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY());
    sky.addColorStop(0.00, "#04050C");     // near-black indigo overhead
    sky.addColorStop(0.26, "#0A0E20");
    sky.addColorStop(0.50, "#1B1531");
    sky.addColorStop(0.72, "#432235");
    sky.addColorStop(0.88, "#883E22");
    sky.addColorStop(1.00, "#CE7028");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, horizonY() + 1);
  }

  function drawStars(time) {
    ctx.save();
    for (let i = 0; i < 40; i++) {
      const x = ((i * 97) % 100) / 100 * width;
      const y = ((i * 61) % 100) / 100 * horizonY() * 0.48;
      const twinkle = 0.35 + 0.3 * Math.sin(time / 1600 + i);
      ctx.fillStyle = "rgba(214,222,255," + (0.15 * twinkle).toFixed(3) + ")";
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.restore();
  }

  function drawClouds(time) {
    // Three bands of thin cloud, lit from below. Drawn as long soft
    // ellipses rather than blobs — dawn cloud is stratified, and a round
    // cloud is the fastest way to make a sky look painted.
    const drift = still ? 0 : time / 90000;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 14; i++) {
      const band = i % 3;
      const y = horizonY() * (0.40 + band * 0.16) + Math.sin(i * 2.3) * 6;
      const x = ((i * 0.137 + drift * (1 + band * 0.4)) % 1.35 - 0.18) * width;
      const w = width * (0.10 + ((i * 37) % 11) / 11 * 0.16);
      const h = height * (0.008 + ((i * 53) % 7) / 7 * 0.011);
      const lit = Math.max(0, 1 - Math.abs(x - sunX()) / (width * 0.75));
      const g = ctx.createRadialGradient(x, y, 0, x, y, w);
      g.addColorStop(0, "rgba(" + (200 + 55 * lit).toFixed(0) + ",140,90," +
                        (0.055 + 0.105 * lit).toFixed(3) + ")");
      g.addColorStop(0.55, "rgba(150,96,110,0.028)");
      g.addColorStop(1, "rgba(90,70,120,0)");
      ctx.fillStyle = g;
      ctx.save();
      ctx.translate(x, y); ctx.scale(1, h / w);
      ctx.beginPath(); ctx.arc(0, 0, w, 0, 6.283); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------------- sun */

  function drawGodRays(time) {
    // Shafts through the haze. Each is drawn twice — a wide soft wedge and
    // a narrow brighter core — because a single hard-edged triangle reads
    // as a drawn ray rather than as light in air. Clipped to the sky: a
    // shaft crossing the tarmac would give the game away instantly.
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
      for (const pass of [{ w: 0.22, a: 0.010 }, { w: 0.07, a: 0.012 }]) {
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

    const wash = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius * 11);
    wash.addColorStop(0, "rgba(255,170,80,0.17)");
    wash.addColorStop(0.28, "rgba(226,110,45,0.09)");
    wash.addColorStop(1, "rgba(120,40,20,0)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, width, height);

    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 2.8);
    core.addColorStop(0, "rgba(255,238,206,0.58)");
    core.addColorStop(0.4, "rgba(255,180,96,0.22)");
    core.addColorStop(1, "rgba(255,150,70,0)");
    ctx.fillStyle = core;
    ctx.fillRect(cx - radius * 3.2, cy - radius * 3.2, radius * 6.4, radius * 6.4);

    // Anamorphic streak. A real lens smears a bright point sideways, and
    // one horizontal flare does more for the "shot on something" feeling
    // than any amount of extra bloom.
    const streak = ctx.createLinearGradient(cx - width * 0.42, 0, cx + width * 0.42, 0);
    streak.addColorStop(0.00, "rgba(255,150,70,0)");
    streak.addColorStop(0.34, "rgba(255,176,96,0.045)");
    streak.addColorStop(0.50, "rgba(255,222,176,0.14)");
    streak.addColorStop(0.66, "rgba(255,176,96,0.045)");
    streak.addColorStop(1.00, "rgba(255,150,70,0)");
    ctx.fillStyle = streak;
    ctx.fillRect(cx - width * 0.42, cy - radius * 0.14, width * 0.84, radius * 0.28);
    ctx.restore();

    const disc = ctx.createRadialGradient(cx, cy - radius * 0.22, 0, cx, cy, radius);
    disc.addColorStop(0.00, "#FFEDD0");
    disc.addColorStop(0.42, "#FFC97E");
    disc.addColorStop(0.82, "rgba(240,140,54,0.94)");
    disc.addColorStop(1.00, "rgba(214,104,36,0)");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 6.283);
    ctx.fill();
  }

  /* -------------------------------------------------------------- ground */

  function drawGround() {
    const y1 = horizonY();
    const earth = ctx.createLinearGradient(0, y1, 0, height);
    earth.addColorStop(0.00, "#7A4A30");
    earth.addColorStop(0.02, "#4E332F");
    earth.addColorStop(0.07, "#2A2130");
    earth.addColorStop(0.18, "#121120");
    earth.addColorStop(0.48, "#09090F");
    earth.addColorStop(1.00, "#040409");
    ctx.fillStyle = earth;
    ctx.fillRect(0, y1, width, height - y1);

    const spill = ctx.createRadialGradient(sunX(), y1, 0, sunX(), y1, width * 0.5);
    spill.addColorStop(0.00, "rgba(228,132,58,0.30)");
    spill.addColorStop(0.34, "rgba(150,78,48,0.09)");
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

  /* ------------------------------------------------------------ the city */

  function facadeGradient(top, bottom, fog, xRef, alphaTop, alphaBot) {
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, veil([0, 0, 0], xRef, fog, alphaTop));
    g.addColorStop(1, veil([0, 0, 0], xRef, fog, alphaBot));
    return g;
  }

  function drawBuilding(b, time) {
    const zNear = b.s0 - travel, zFar = b.s1 - travel;
    if (zFar <= 0.8) return;
    const z0 = Math.max(0.82, zNear);
    if (z0 > CITY_FAR) return;

    const fog = fogOf((z0 + zFar) * 0.5);
    const kNear = halfAt(z0);

    // Corners of the two faces we can see: the one looking at the road and
    // the one looking at the camera.
    const A = P(b.uIn, 0, z0),  B = P(b.uIn, 0, zFar);
    const C = P(b.uIn, b.h, zFar), D = P(b.uIn, b.h, z0);
    const E = P(b.uOut, 0, z0), F = P(b.uOut, b.h, z0);

    const xRef = (A.x + B.x) * 0.5;
    if (Math.max(A.x, B.x, E.x) < -40 && b.side < 0) { /* still draw: cheap */ }

    // The face towards the camera is the darkest thing in the frame; the
    // face along the road catches a little of the sky. Both are graded top
    // to bottom, because a facade is never one value.
    const skinTop = b.skin.top, skinBase = b.skin.base;
    const gSide = ctx.createLinearGradient(0, Math.min(C.y, D.y), 0, Math.max(A.y, B.y));
    gSide.addColorStop(0, veil([skinTop[0] * 1.0, skinTop[1], skinTop[2]], xRef, fog));
    gSide.addColorStop(0.55, veil(skinBase, xRef, fog));
    gSide.addColorStop(1, veil([skinBase[0] * 0.55, skinBase[1] * 0.55, skinBase[2] * 0.6], xRef, fog));

    quad(A, B, C, D);
    ctx.fillStyle = gSide;
    ctx.fill();

    // Front face, one step darker — it is turned away from every light in
    // the scene.
    const gFront = ctx.createLinearGradient(0, F.y, 0, E.y);
    gFront.addColorStop(0, veil([skinTop[0] * 0.62, skinTop[1] * 0.62, skinTop[2] * 0.68], xRef, fog));
    gFront.addColorStop(1, veil([skinBase[0] * 0.40, skinBase[1] * 0.40, skinBase[2] * 0.46], xRef, fog));
    quad(A, E, F, D);
    ctx.fillStyle = gFront;
    ctx.fill();

    // Tooth. Without it a facade is a flat fill and reads as card.
    if (concretePat && fog < 0.6 && kNear > 90) {
      ctx.save();
      quad(A, B, C, D); ctx.clip();
      const bx = Math.min(A.x, B.x) - 2, by = Math.min(C.y, D.y) - 2;
      const bw = Math.abs(A.x - B.x) + 4, bh = Math.abs(A.y - C.y) + 4;
      ctx.globalAlpha = 0.5 * (1 - fog);
      ctx.fillStyle = concretePat;
      ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 1;

      // Blotching, at the scale of a wall rather than of a grain. Plaster
      // dries unevenly, gets patched, and holds damp in the places it was
      // patched; even fine tooth over a perfectly flat fill still reads as
      // paper until something varies across metres and not millimetres.
      const seed = Math.round(b.s0 * 17) + (b.side > 0 ? 991 : 0);
      for (let i = 0; rich && i < 7; i++) {
        const cx = bx + bw * hash(seed + i, 91);
        const cy = by + bh * hash(seed + i, 92);
        const rr = Math.max(bw, bh) * (0.10 + hash(seed + i, 93) * 0.26);
        const dark = hash(seed + i, 94) < 0.62;
        const a = (0.030 + hash(seed + i, 95) * 0.045) * (1 - fog);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        g.addColorStop(0, (dark ? "rgba(0,0,0," : "rgba(196,178,150,") + a.toFixed(3) + ")");
        g.addColorStop(1, (dark ? "rgba(0,0,0,0)" : "rgba(196,178,150,0)"));
        ctx.fillStyle = g;
        ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      }
      ctx.restore();
    }

    drawWindows(b, z0, zFar, fog, xRef, time);
    drawFloorLines(b, z0, zFar, fog, xRef);
    drawWeathering(b, z0, zFar, fog, xRef);
    drawFixtures(b, z0, zFar, fog, xRef);
    drawRoof(b, z0, zFar, fog, xRef);

    // Rim light. The vertical edge nearest the vanishing point and the top
    // parapet both stand against the bright sky, so both catch it. This one
    // detail does more than anything else to lift the buildings off the
    // background.
    const rim = Math.max(0, 1 - fog) * 0.55;
    if (rim > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = "rgba(255,186,116," + (0.30 * rim).toFixed(3) + ")";
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.stroke();
      ctx.strokeStyle = "rgba(255,204,152," + (0.22 * rim).toFixed(3) + ")";
      ctx.beginPath(); ctx.moveTo(C.x, C.y); ctx.lineTo(D.x, D.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(D.x, D.y); ctx.lineTo(F.x, F.y); ctx.stroke();
      ctx.restore();
    }

    // Where the wall meets the pavement. Contact shadow: the cheapest way
    // to stop a building floating.
    const foot = ctx.createLinearGradient(0, (A.y + B.y) / 2 - kNear * 0.10, 0, (A.y + B.y) / 2 + kNear * 0.02);
    foot.addColorStop(0, "rgba(0,0,0,0)");
    foot.addColorStop(1, "rgba(0,0,0," + (0.45 * (1 - fog)).toFixed(3) + ")");
    ctx.save();
    quad(A, B, C, D); ctx.clip();
    ctx.fillStyle = foot;
    ctx.fillRect(Math.min(A.x, B.x), (A.y + B.y) / 2 - kNear * 0.12,
                 Math.abs(A.x - B.x) + 2, kNear * 0.14);
    ctx.restore();
  }

  function drawWeathering(b, z0, zFar, fog, xRef) {
    // Monsoon staining. Water runs off a sill, down the plaster, and leaves
    // a dark tail that gets wider as it falls. Nothing else so cheaply
    // says "this wall has stood outside for fifteen years" — and a wall
    // that has never been rained on is the thing that reads as a render.
    const k = halfAt((z0 + zFar) / 2);
    if (!rich || k * b.storeyH < 16 || fog > 0.62) return;
    const zA = b.s0 - travel, zB = b.s1 - travel;
    const seed = Math.round(b.s0 * 13) + (b.side > 0 ? 7777 : 0);

    ctx.save();
    quad(P(b.uIn, 0, Math.max(0.85, zA)), P(b.uIn, 0, zB),
         P(b.uIn, b.h, zB), P(b.uIn, b.h, Math.max(0.85, zA)));
    ctx.clip();

    const streaks = 5 + ((hash(seed, 61) * 6) | 0);
    for (let i = 0; i < streaks; i++) {
      const at = hash(seed + i, 62);
      const sPos = zA + (zB - zA) * (0.06 + at * 0.88);
      if (sPos < 0.9) continue;
      const fromRow = 1 + ((hash(seed + i, 63) * b.rows) | 0);
      const hTop = Math.min(b.h, fromRow * b.storeyH + b.storeyH * 0.18);
      const drop = b.storeyH * (0.5 + hash(seed + i, 64) * 2.2);
      const hBot = Math.max(0, hTop - drop);

      const w0 = 0.012 + hash(seed + i, 65) * 0.012;
      const w1 = w0 * (1.8 + hash(seed + i, 66) * 1.6);
      const t1 = P(b.uIn, hTop, sPos - w0), t2 = P(b.uIn, hTop, sPos + w0);
      const b1 = P(b.uIn, hBot, sPos + w1), b2 = P(b.uIn, hBot, sPos - w1);

      const g = ctx.createLinearGradient(0, (t1.y + t2.y) / 2, 0, (b1.y + b2.y) / 2);
      const a = (0.16 + hash(seed + i, 67) * 0.18) * (1 - fog);
      g.addColorStop(0.00, "rgba(0,0,0," + (a * 0.9).toFixed(3) + ")");
      g.addColorStop(0.55, "rgba(0,0,0," + (a * 0.5).toFixed(3) + ")");
      g.addColorStop(1.00, "rgba(0,0,0,0)");
      quad(t1, t2, b1, b2);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // Damp rising out of the ground at the base of the wall.
    const g2 = ctx.createLinearGradient(0, yAt(Math.max(1, (z0 + zFar) / 2)) - k * b.storeyH * 0.55, 0,
                                        yAt(Math.max(1, (z0 + zFar) / 2)));
    g2.addColorStop(0, "rgba(0,0,0,0)");
    g2.addColorStop(1, "rgba(6,8,10," + (0.30 * (1 - fog)).toFixed(3) + ")");
    ctx.fillStyle = g2;
    ctx.fillRect(Math.min(P(b.uIn, 0, Math.max(0.85, zA)).x, P(b.uIn, 0, zB).x) - 4,
                 yAt(Math.max(1, (z0 + zFar) / 2)) - k * b.storeyH * 0.6,
                 Math.abs(P(b.uIn, 0, Math.max(0.85, zA)).x - P(b.uIn, 0, zB).x) + 8,
                 k * b.storeyH * 0.62);
    ctx.restore();
  }

  function drawFixtures(b, z0, zFar, fog, xRef) {
    // Downpipes, split units and the cables somebody ran across the front.
    // A facade is never just wall and windows; it is wall, windows, and
    // everything that has been bolted to it since. These are the parts the
    // eye does not consciously notice and immediately misses.
    const k = halfAt((z0 + zFar) / 2);
    if (!rich || k * b.storeyH < 20 || fog > 0.55) return;
    const zA = Math.max(0.85, b.s0 - travel), zB = b.s1 - travel;
    if (zB <= zA) return;
    const seed = Math.round(b.s0 * 29) + (b.side > 0 ? 313 : 0);
    const dim = 1 - fog;
    const out = b.side * 0.028;

    ctx.save();
    ctx.lineCap = "butt";

    // Rainwater downpipes, run down the joint between two bays.
    const pipes = 1 + ((hash(seed, 81) * 2) | 0);
    for (let i = 0; i < pipes; i++) {
      const sPos = zA + (zB - zA) * (0.12 + hash(seed + i, 82) * 0.76);
      if (sPos < 0.9) continue;
      const p1 = P(b.uIn + out, b.h - b.parapet * 0.4, sPos);
      const p2 = P(b.uIn + out, 0.02, sPos);
      ctx.strokeStyle = veil([13, 12, 17], xRef, fog, 0.88);
      ctx.lineWidth = Math.max(1, k * 0.014);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      // The shadow it throws onto the wall, one pixel to the shaded side.
      ctx.strokeStyle = "rgba(0,0,0," + (0.30 * dim).toFixed(3) + ")";
      ctx.lineWidth = Math.max(0.8, k * 0.010);
      ctx.beginPath();
      ctx.moveTo(p1.x + 2 * b.side, p1.y); ctx.lineTo(p2.x + 2 * b.side, p2.y);
      ctx.stroke();
    }

    // Split-unit condensers, hung under windows.
    const units = 2 + ((hash(seed, 83) * 4) | 0);
    for (let i = 0; i < units; i++) {
      const r = 1 + ((hash(seed + i, 84) * (b.rows - 1)) | 0);
      const sPos = zA + (zB - zA) * (0.1 + hash(seed + i, 85) * 0.8);
      if (sPos < 0.9) continue;
      const hA = r * b.storeyH + b.storeyH * 0.06;
      const hB = hA + b.storeyH * 0.14;
      const sw = (zB - zA) * 0.055;
      const f1 = P(b.uIn + out * 2.2, hA, sPos - sw), f2 = P(b.uIn + out * 2.2, hA, sPos + sw);
      const f3 = P(b.uIn + out * 2.2, hB, sPos + sw), f4 = P(b.uIn + out * 2.2, hB, sPos - sw);
      quad(f1, f2, f3, f4);
      ctx.fillStyle = veil([31, 30, 36], xRef, fog, 0.95);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0," + (0.45 * dim).toFixed(3) + ")";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // A service cable, sagging along the front just above the shopfronts.
    if (hash(seed, 86) < 0.7) {
      const h = b.storeyH * (1.02 + hash(seed, 87) * 0.4);
      const c1 = P(b.uIn + out, h, zA), c2 = P(b.uIn + out, h, zB);
      ctx.strokeStyle = "rgba(8,8,12," + (0.7 * dim).toFixed(3) + ")";
      ctx.lineWidth = Math.max(0.7, k * 0.004);
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.quadraticCurveTo((c1.x + c2.x) / 2, (c1.y + c2.y) / 2 + k * 0.035, c2.x, c2.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFloorLines(b, z0, zFar, fog, xRef) {
    // Slab edges. Horizontal banding is most of what tells you a facade has
    // storeys, and it survives at distances where windows are gone.
    if (fog > 0.72) return;
    const k = halfAt((z0 + zFar) / 2);
    if (k * b.storeyH < 5) return;
    ctx.save();
    ctx.strokeStyle = veil([0, 0, 0], xRef, fog, 0.30 * (1 - fog));
    ctx.lineWidth = Math.max(0.6, k * 0.012);
    for (let r = 1; r < b.rows; r++) {
      const h = r * b.storeyH;
      const p1 = P(b.uIn, h, z0), p2 = P(b.uIn, h, zFar);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawWindows(b, z0, zFar, fog, xRef, time) {
    const k = halfAt((z0 + zFar) / 2);
    const cellH = k * b.storeyH;
    if (cellH < 3.0 || fog > 0.88) return;

    const zA = b.s0 - travel, zB = b.s1 - travel;
    const marg = 0.09;
    const span = (zB - zA) - marg * 2;
    if (span <= 0) return;
    const cw = span / b.cols;
    const detail = cellH > 15;   // close enough to see a window frame

    // Batched by what the light is, so a distant building is three fills
    // rather than one per pane. Only the near ones earn the detailed path.
    const dark = new Path2D(), warm = new Path2D(), cool = new Path2D();
    const bloom = [];
    const near = [];

    for (const cell of b.cells) {
      const sA = zA + marg + cell.c * cw + cw * 0.19;
      const sB = sA + cw * 0.62;
      if (sB <= 0.85) continue;
      const s1 = Math.max(0.85, sA);
      const hA = cell.r * b.storeyH + b.storeyH * 0.20;
      const hB = cell.r * b.storeyH + b.storeyH * 0.74;

      const p1 = P(b.uIn, hA, s1), p2 = P(b.uIn, hA, sB);
      const p3 = P(b.uIn, hB, sB), p4 = P(b.uIn, hB, s1);

      if (detail) {
        near.push({ cell: cell, sA: s1, sB: sB, hA: hA, hB: hB, p: [p1, p2, p3, p4] });
      } else {
        const target = cell.lit === 0 ? dark : cell.lit === 1 ? warm : cool;
        addQuad(target, p1, p2, p3, p4);
      }
      if (cell.lit && cellH > 7) {
        bloom.push({ x: (p1.x + p3.x) / 2, y: (p1.y + p3.y) / 2,
                     r: Math.abs(p1.y - p4.y) * 1.7, lit: cell.lit, a: cell.a,
                     flick: cell.flick });
      }
    }

    const dim = 1 - fog;

    if (!detail) {
      // Unlit glass is not black; it is a darker, cooler version of the
      // wall with a little of the sky in it.
      ctx.fillStyle = veil([12, 13, 20], xRef, fog, 0.78);
      ctx.fill(dark);
      ctx.fillStyle = veil([255, 186, 108], xRef, fog * 0.7, 0.52 * dim + 0.08);
      ctx.fill(warm);
      ctx.fillStyle = veil([196, 220, 255], xRef, fog * 0.7, 0.42 * dim + 0.06);
      ctx.fill(cool);
    } else {
      for (const w of near) drawOneWindow(b, w, fog, xRef);
    }

    if (bloom.length) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const w of bloom) {
        let a = w.a * dim * 0.22;
        if (w.flick) a *= 0.72 + 0.28 * Math.sin(time / 90 * w.flick);
        if (a < 0.01) continue;
        const g = ctx.createRadialGradient(w.x, w.y, 0, w.x, w.y, w.r);
        const c = w.lit === 1 ? "255,178,96" : "180,212,255";
        g.addColorStop(0, "rgba(" + c + "," + a.toFixed(3) + ")");
        g.addColorStop(1, "rgba(" + c + ",0)");
        ctx.fillStyle = g;
        ctx.fillRect(w.x - w.r, w.y - w.r, w.r * 2, w.r * 2);
      }
      ctx.restore();
    }

    if (b.balcony && cellH > 11) drawBalconies(b, zA, zB, fog, xRef, k);

    // Shopfront: shutters, and a lit signboard over them.
    if (b.sign && cellH > 8) drawShopfront(b, zA, zB, fog, xRef, k);
  }

  function drawOneWindow(b, w, fog, xRef) {
    // A window is a hole in a wall, not a rectangle painted on one. What
    // sells it is the order: the dark reveal first, the glass inset inside
    // it, then a sill catching the sky along the bottom edge.
    const p = w.p;
    const dim = 1 - fog;

    quad(p[0], p[1], p[2], p[3]);
    ctx.fillStyle = veil([9, 9, 14], xRef, fog, 0.92);
    ctx.fill();

    const hIn = (w.hB - w.hA) * 0.13, sIn = (w.sB - w.sA) * 0.13;
    const g1 = P(b.uIn, w.hA + hIn, w.sA + sIn), g2 = P(b.uIn, w.hA + hIn, w.sB - sIn);
    const g3 = P(b.uIn, w.hB - hIn, w.sB - sIn), g4 = P(b.uIn, w.hB - hIn, w.sA + sIn);

    quad(g1, g2, g3, g4);
    if (w.cell.lit) {
      // Lit glass falls off downwards: the fitting is on the ceiling, and
      // there is usually something in front of the lower half of the pane.
      const top = Math.min(g3.y, g4.y), bot = Math.max(g1.y, g2.y);
      const c = w.cell.lit === 1 ? [255, 186, 108] : [200, 222, 255];
      const lg = ctx.createLinearGradient(0, top, 0, bot);
      lg.addColorStop(0.00, veil(c, xRef, fog * 0.6, (0.62 * dim + 0.08) * w.cell.a));
      lg.addColorStop(0.62, veil(c, xRef, fog * 0.6, (0.40 * dim + 0.05) * w.cell.a));
      lg.addColorStop(1.00, veil([c[0] * 0.5, c[1] * 0.45, c[2] * 0.5], xRef, fog * 0.6,
                                 (0.22 * dim + 0.03) * w.cell.a));
      ctx.fillStyle = lg;
    } else {
      // Dark glass still reflects the sky above it.
      const top = Math.min(g3.y, g4.y), bot = Math.max(g1.y, g2.y);
      const dg = ctx.createLinearGradient(0, top, 0, bot);
      dg.addColorStop(0, veil([46, 44, 62], xRef, fog, 0.80));
      dg.addColorStop(1, veil([12, 12, 19], xRef, fog, 0.92));
      ctx.fillStyle = dg;
    }
    ctx.fill();

    // Mullion, then the sill. Both are one line each and both are the
    // difference between a pane and a painted box.
    const mid = (w.sA + w.sB) / 2;
    const m1 = P(b.uIn, w.hA + hIn, mid), m2 = P(b.uIn, w.hB - hIn, mid);
    ctx.strokeStyle = veil([8, 8, 12], xRef, fog, 0.75);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.stroke();

    ctx.strokeStyle = "rgba(214,186,152," + (0.20 * dim).toFixed(3) + ")";
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y + 1); ctx.lineTo(p[1].x, p[1].y + 1);
    ctx.stroke();
  }

  function drawBalconies(b, zA, zB, fog, xRef, k) {
    // A slab and a railing per storey, on the bays that have one. The slab
    // sticks out towards the road, so it throws the facade into shadow
    // underneath — that shadow is most of the effect.
    const dim = 1 - fog;
    const out = b.side * 0.13;
    for (let r = 1; r < b.rows; r++) {
      if (hash(r * 31 + Math.round(b.s0 * 7), 11) < 0.35) continue;
      const h = r * b.storeyH;
      const sA = Math.max(0.85, zA + b.depth * 0.14), sB = zB - b.depth * 0.14;
      if (sB <= sA) continue;

      // Underside, in shadow.
      const u1 = P(b.uIn, h, sA), u2 = P(b.uIn, h, sB);
      const u3 = P(b.uIn + out, h, sB), u4 = P(b.uIn + out, h, sA);
      quad(u1, u2, u3, u4);
      ctx.fillStyle = veil([0, 0, 0], xRef, fog * 0.5, 0.55 * dim + 0.1);
      ctx.fill();

      // Front edge of the slab, catching the sky.
      const e1 = P(b.uIn + out, h, sA), e2 = P(b.uIn + out, h, sB);
      const e3 = P(b.uIn + out, h + 0.045, sB), e4 = P(b.uIn + out, h + 0.045, sA);
      quad(e1, e2, e3, e4);
      ctx.fillStyle = veil([64, 58, 62], xRef, fog, 0.95);
      ctx.fill();

      // Railing: verticals plus a top rail, all hairline.
      if (k * b.storeyH > 22) {
        ctx.save();
        ctx.strokeStyle = veil([10, 10, 15], xRef, fog, 0.7 * dim + 0.15);
        ctx.lineWidth = Math.max(0.6, k * 0.0035);
        const bars = 7;
        for (let i = 0; i <= bars; i++) {
          const sPos = sA + (sB - sA) * (i / bars);
          const a = P(b.uIn + out, h + 0.045, sPos), c = P(b.uIn + out, h + 0.20, sPos);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        }
        const t1 = P(b.uIn + out, h + 0.20, sA), t2 = P(b.uIn + out, h + 0.20, sB);
        ctx.lineWidth = Math.max(0.7, k * 0.005);
        ctx.beginPath(); ctx.moveTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawShopfront(b, zA, zB, fog, xRef, k) {
    const dim = 1 - fog;
    const sA = Math.max(0.85, zA + 0.06), sB = zB - 0.06;
    if (sB <= sA) return;

    // Rolling shutters: a dark recess with fine horizontal ribbing.
    const q1 = P(b.uIn, 0.02, sA), q2 = P(b.uIn, 0.02, sB);
    const q3 = P(b.uIn, b.storeyH * 0.70, sB), q4 = P(b.uIn, b.storeyH * 0.70, sA);
    quad(q1, q2, q3, q4);
    ctx.fillStyle = veil([20, 19, 25], xRef, fog, 0.95);
    ctx.fill();
    if (k * b.storeyH > 26) {
      ctx.save();
      quad(q1, q2, q3, q4); ctx.clip();
      ctx.strokeStyle = veil([44, 41, 50], xRef, fog, 0.6);
      ctx.lineWidth = 1;
      for (let i = 1; i < 9; i++) {
        const h = b.storeyH * 0.70 * (i / 9);
        const a = P(b.uIn, h, sA), c = P(b.uIn, h, sB);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      }
      ctx.restore();
    }

    // The signboard over them.
    const hA = b.storeyH * 0.78, hB = b.storeyH * 0.98;
    const r1 = P(b.uIn, hA, sA), r2 = P(b.uIn, hA, sB);
    const r3 = P(b.uIn, hB, sB), r4 = P(b.uIn, hB, sA);
    quad(r1, r2, r3, r4);
    const c = b.sign.warm ? [236, 156, 70] : [96, 168, 176];
    ctx.fillStyle = veil(c, xRef, fog * 0.6, 0.62 * b.sign.a * dim + 0.30);
    ctx.fill();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const mid = { x: (r1.x + r3.x) / 2, y: (r1.y + r3.y) / 2 };
    const rr = Math.abs(r1.x - r2.x) * 0.55 + 8;
    const g = ctx.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, rr);
    g.addColorStop(0, "rgba(" + c.join(",") + "," + (0.13 * dim).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + c.join(",") + ",0)");
    ctx.fillStyle = g;
    ctx.fillRect(mid.x - rr, mid.y - rr, rr * 2, rr * 2);
    ctx.restore();
  }

  function drawRoof(b, z0, zFar, fog, xRef) {
    const k = halfAt((z0 + zFar) / 2);
    if (k * 0.2 < 2.5 || fog > 0.8) return;
    const dark = veil([16, 15, 22], xRef, fog, 0.95);

    for (const r of b.roof) {
      if (r.t === "tank") {
        const su = b.side * (b.inset + r.u * b.girth);
        const sv = b.side * (b.inset + (r.u + r.w) * b.girth);
        const sa = Math.max(0.85, b.s0 - travel + r.s * b.depth);
        const sb = sa + r.w * 1.2;
        const p1 = P(su, b.h, sa), p2 = P(sv, b.h, sa);
        const p3 = P(sv, b.h + r.h, sa), p4 = P(su, b.h + r.h, sa);
        quad(p1, p2, p3, p4);
        ctx.fillStyle = dark;
        ctx.fill();
        const s1 = P(su, b.h + r.h, sa), s2 = P(su, b.h + r.h, sb);
        const s3 = P(su, b.h, sb), s4 = P(su, b.h, sa);
        quad(s1, s2, s3, s4);
        ctx.fillStyle = veil([26, 24, 32], xRef, fog, 0.95);
        ctx.fill();
      } else if (r.t === "board") {
        // Only at a distance where it reads as a hoarding. Right on top of
        // the camera it is a wall of colour and nothing else.
        if (b.s0 - travel < 3.2) continue;
        const su = b.side * (b.inset + r.u * b.girth);
        const sv = b.side * (b.inset + Math.min(1, r.u + r.w) * b.girth);
        const sa = Math.max(0.85, b.s0 - travel + b.depth * 0.12);
        const p1 = P(su, b.h, sa), p2 = P(sv, b.h, sa);
        const p3 = P(sv, b.h + r.h, sa), p4 = P(su, b.h + r.h, sa);
        const c = r.warm ? [176, 112, 52] : [66, 104, 118];
        quad(p1, p2, p3, p4);
        ctx.fillStyle = veil(c, xRef, fog * 0.5, 0.92);
        ctx.fill();
        ctx.strokeStyle = veil([10, 10, 14], xRef, fog, 0.9);
        ctx.lineWidth = Math.max(0.8, k * 0.006);
        ctx.stroke();
        // The legs it stands on, so it is not floating above the parapet.
        ctx.beginPath();
        for (let g = 0; g <= 2; g++) {
          const t = g / 2;
          const a1 = P(su + (sv - su) * t, b.h, sa);
          const a2 = P(su + (sv - su) * t, b.h + r.h, sa);
          ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y);
        }
        ctx.stroke();
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const mid = { x: (p1.x + p3.x) / 2, y: (p1.y + p3.y) / 2 };
        const rr = Math.max(10, Math.abs(p1.x - p2.x));
        const g = ctx.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, rr);
        g.addColorStop(0, "rgba(" + c.join(",") + "," + (0.09 * (1 - fog)).toFixed(3) + ")");
        g.addColorStop(1, "rgba(" + c.join(",") + ",0)");
        ctx.fillStyle = g;
        ctx.fillRect(mid.x - rr, mid.y - rr, rr * 2, rr * 2);
        ctx.restore();
      } else if (r.t === "mast") {
        const su = b.side * (b.inset + r.u * b.girth);
        const sa = Math.max(0.85, b.s0 - travel + b.depth * 0.4);
        const p1 = P(su, b.h, sa), p2 = P(su, b.h + r.h, sa);
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(0.7, k * 0.006);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        ctx.fillStyle = "rgba(226,72,60," + (0.7 * (1 - fog)).toFixed(2) + ")";
        ctx.beginPath(); ctx.arc(p2.x, p2.y, Math.max(0.9, k * 0.005), 0, 6.283); ctx.fill();
      }
    }
  }

  function drawCity(time) {
    recycleCity();
    // Painter's algorithm across both pavements at once, so a tall block on
    // one side correctly hides a low one on the other.
    const all = cityL.concat(cityR);
    all.sort(function (a, b) { return b.s0 - a.s0; });
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    for (const b of all) drawBuilding(b, time);
    ctx.restore();
  }

  /* ------------------------------------------------------- lamps + wires */

  function drawLamps() {
    const lamps = lampsInView();
    lamps.sort(function (a, b) { return b.z - a.z; });

    // The wires first, behind the poles.
    ctx.save();
    for (const side of [-1, 1]) {
      const line = lamps.filter(function (l) { return l.side === side; });
      line.sort(function (a, b) { return b.z - a.z; });
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        if (a.z < 1.2 || b.z < 1.2) continue;
        const fog = fogOf((a.z + b.z) / 2);
        if (fog > 0.85) continue;
        const pa = P(LAMP_U * side, LAMP_H * 0.86, a.z);
        const pb = P(LAMP_U * side, LAMP_H * 0.86, b.z);
        const sag = halfAt((a.z + b.z) / 2) * 0.055;
        for (let w = 0; w < 3; w++) {
          ctx.strokeStyle = "rgba(10,9,14," + (0.55 * (1 - fog)).toFixed(3) + ")";
          ctx.lineWidth = Math.max(0.5, halfAt((a.z + b.z) / 2) * 0.0035);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y + w * 3);
          ctx.quadraticCurveTo((pa.x + pb.x) / 2, (pa.y + pb.y) / 2 + sag + w * 3,
                               pb.x, pb.y + w * 3);
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    for (const l of lamps) {
      if (l.z < 0.9) continue;
      const fog = fogOf(l.z);
      if (fog > 0.9) continue;
      const k = halfAt(l.z);
      const u = LAMP_U * l.side;
      const base = P(u, 0, l.z), top = P(u, LAMP_H, l.z);
      const armEnd = P(u - l.side * 0.34, LAMP_H * 0.985, l.z);
      const w = Math.max(0.8, k * 0.011);

      ctx.save();
      ctx.strokeStyle = veil([12, 11, 16], base.x, fog * 0.7, 0.92);
      ctx.lineCap = "round";
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      ctx.lineWidth = w * 0.8;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.quadraticCurveTo(top.x, top.y - k * 0.06, armEnd.x, armEnd.y);
      ctx.stroke();
      // The lamp head itself.
      ctx.fillStyle = veil([16, 15, 20], base.x, fog * 0.7, 0.95);
      ctx.beginPath();
      ctx.ellipse(armEnd.x, armEnd.y, Math.max(1.2, k * 0.020), Math.max(0.7, k * 0.008), 0, 0, 6.283);
      ctx.fill();
      ctx.restore();
      l.head = armEnd;
      l.k = k;
      l.fog = fog;
    }
    return lamps;
  }

  function drawLampGlow(lamps) {
    // Drawn after the road so the pools land on the tarmac. Sodium vapour:
    // orange, and never white.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const l of lamps) {
      if (!l.on || !l.head || l.z < 0.9) continue;
      const fade = (1 - l.fog) * Math.min(1, (l.z - 0.9) / 1.4);
      if (fade <= 0.02) continue;
      const k = l.k;

      const r = Math.max(5, Math.min(k * 0.13, width * 0.07));
      const halo = ctx.createRadialGradient(l.head.x, l.head.y, 0, l.head.x, l.head.y, r);
      halo.addColorStop(0.00, "rgba(255,208,142," + (0.50 * fade).toFixed(3) + ")");
      halo.addColorStop(0.18, "rgba(255,164,74," + (0.15 * fade).toFixed(3) + ")");
      halo.addColorStop(1.00, "rgba(220,120,40,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(l.head.x - r, l.head.y - r, r * 2, r * 2);

      // The pool on the road below, squashed by perspective.
      const u = (LAMP_U - 0.34) * l.side;
      const pool = P(u, 0, l.z);
      const pr = Math.max(8, Math.min(k * 0.48, width * 0.30));
      ctx.save();
      ctx.translate(pool.x, pool.y);
      ctx.scale(1, 0.20);
      const pg = ctx.createRadialGradient(0, 0, 0, 0, 0, pr);
      pg.addColorStop(0.00, "rgba(255,178,92," + (0.30 * fade).toFixed(3) + ")");
      pg.addColorStop(0.45, "rgba(232,140,58," + (0.10 * fade).toFixed(3) + ")");
      pg.addColorStop(1.00, "rgba(200,110,40,0)");
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(0, 0, pr, 0, 6.283); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /* --------------------------------------------------------------- trees */

  // Street trees. Buildings are boxes and a street built only from boxes
  // looks generated no matter how well the boxes are lit; a canopy is the
  // one shape in the frame with no straight edge in it, and the eye reads
  // the whole scene as real the moment it finds one.
  const TREE_GAP = 4.1, TREE_U = 1.30;

  function drawTrees(fogGate) {
    const first = Math.ceil((travel + 0.9) / TREE_GAP);
    const out = [];
    for (let i = first; i < first + 34; i++) {
      const s = i * TREE_GAP;
      const z = s - travel;
      if (z > 52) break;
      if (hash(i, 5) > 0.42) continue;                 // not every gap has one
      out.push({ z: z, i: i, side: hash(i, 6) < 0.5 ? -1 : 1 });
    }
    out.sort(function (a, b) { return b.z - a.z; });

    for (const t of out) {
      const fog = fogOf(t.z);
      if (fog > 0.86) continue;
      const k = halfAt(t.z);
      const u = (TREE_U + hash(t.i, 7) * 0.10) * t.side;
      const trunk = 0.52 + hash(t.i, 8) * 0.40;
      const crown = 0.46 + hash(t.i, 9) * 0.34;
      const base = P(u, 0.035, t.z);
      const fork = P(u, trunk, t.z);
      if (k * 0.05 < 1.2) continue;

      // A canopy at distance is not a black cut-out; the sky comes through
      // it. Fading the ink with depth is what keeps the trees behind the
      // buildings instead of in front of them.
      const ink = veil([10, 10, 14], base.x, fog, 0.62 + 0.34 * (1 - fog));

      ctx.save();
      ctx.strokeStyle = ink;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.1, k * 0.028);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.quadraticCurveTo(base.x + t.side * k * 0.012, (base.y + fork.y) / 2, fork.x, fork.y);
      ctx.stroke();

      // Branch armature first, then foliage clustered on the ends of it.
      // Foliage alone gives a lollipop; the giveaway is that the canopy has
      // no reason for its shape. Grow the branches and put the leaves where
      // the branches went, and the silhouette stops being a blob.
      const arms = 4 + ((hash(t.i, 12) * 3) | 0);
      const tips = [];
      ctx.lineWidth = Math.max(0.9, k * 0.017);
      for (let a = 0; a < arms; a++) {
        const ang = -Math.PI * (0.18 + 0.64 * ((a + 0.5) / arms)) +
                    (hash(t.i * 7 + a, 13) - 0.5) * 0.55;
        const len = k * crown * (0.34 + hash(t.i * 7 + a, 14) * 0.42);
        const mx = fork.x + Math.cos(ang) * len * 0.55;
        const my = fork.y + Math.sin(ang) * len * 0.55;
        const ex = fork.x + Math.cos(ang + (hash(t.i * 7 + a, 15) - 0.5) * 0.5) * len;
        const ey = fork.y + Math.sin(ang + (hash(t.i * 7 + a, 15) - 0.5) * 0.5) * len;
        ctx.beginPath();
        ctx.moveTo(fork.x, fork.y);
        ctx.quadraticCurveTo(mx, my, ex, ey);
        ctx.stroke();
        tips.push({ x: ex, y: ey, r: len * 0.42 });
        // A secondary fork, so the structure does not read as a fan.
        if (hash(t.i * 7 + a, 16) < 0.6) {
          const a2 = ang + (hash(t.i * 7 + a, 17) - 0.5) * 1.1;
          const l2 = len * 0.5;
          tips.push({ x: ex + Math.cos(a2) * l2, y: ey + Math.sin(a2) * l2, r: l2 * 0.5 });
        }
      }

      // Foliage: many small lobes on the tips, none of them a circle.
      ctx.fillStyle = ink;
      for (let ti = 0; ti < tips.length; ti++) {
        const tp = tips[ti];
        const lobes = (rich ? 13 : 6) + ((hash(t.i * 23 + ti, 18) * (rich ? 8 : 4)) | 0);
        for (let j = 0; j < lobes; j++) {
          const a = hash(t.i * 91 + ti * 11 + j, 21) * 6.283;
          const d = tp.r * hash(t.i * 91 + ti * 11 + j, 22) * 0.95;
          const rr = tp.r * (0.21 + hash(t.i * 91 + ti * 11 + j, 23) * 0.28);
          if (rr < 0.45) continue;
          // Uneven density: a canopy is thick at the middle of each clump
          // and thins to nothing at the edges, and it is that thinning that
          // stops the silhouette reading as a cut-out.
          ctx.globalAlpha = 0.34 + hash(t.i * 91 + ti * 11 + j, 25) * 0.62;
          ctx.beginPath();
          ctx.ellipse(tp.x + Math.cos(a) * d, tp.y + Math.sin(a) * d * 0.8,
                      rr, rr * (0.55 + hash(t.i * 91 + ti * 11 + j, 24) * 0.5),
                      a * 0.5, 0, 6.283);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      const r0 = k * crown * 0.30;

      // Light through the leaves on the sunward side: a few bright specks
      // rather than a rim, because a canopy has gaps and an edge does not.
      if (fog < 0.55 && r0 > 9) {
        ctx.globalCompositeOperation = "lighter";
        for (let j = 0; j < 12; j++) {
          const tp = tips[(j * 3) % tips.length];
          const a = hash(t.i * 17 + j, 31) * 6.283;
          const d = tp.r * hash(t.i * 17 + j, 32);
          const cx = tp.x + Math.cos(a) * d;
          const cy = tp.y + Math.sin(a) * d * 0.8;
          const lit = Math.max(0, 1 - Math.abs(cx - sunX()) / (width * 0.5));
          ctx.fillStyle = "rgba(255,196,132," + (0.20 * lit * (1 - fog)).toFixed(3) + ")";
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(0.6, r0 * 0.05), 0, 6.283);
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------- pavement */

  function drawPavement() {
    // Footpath and kerb, both sides. Without them the buildings stand in
    // the road and the whole street falls apart.
    for (const side of [-1, 1]) {
      const zN = 0.92, zF = 60;
      const kerbIn = 1.00 * side, kerbOut = 1.06 * side, walkOut = 1.42 * side;

      // Footpath slab.
      quad(P(kerbOut, 0.035, zN), P(walkOut, 0.035, zN),
           P(walkOut, 0.035, zF), P(kerbOut, 0.035, zF));
      const g = ctx.createLinearGradient(0, yAt(zF), 0, height);
      g.addColorStop(0.00, "rgba(70,60,68,0.70)");
      g.addColorStop(0.10, "rgba(33,29,39,0.94)");
      g.addColorStop(0.55, "rgba(18,17,25,1)");
      g.addColorStop(1.00, "rgba(11,10,16,1)");
      ctx.fillStyle = g;
      ctx.fill();

      // Kerb face — vertical, so it catches the sky and reads as a step.
      quad(P(kerbIn, 0, zN), P(kerbIn, 0, zF),
           P(kerbIn, 0.035, zF), P(kerbIn, 0.035, zN));
      const kg = ctx.createLinearGradient(0, yAt(zF), 0, height);
      kg.addColorStop(0.00, "rgba(150,124,110,0.7)");
      kg.addColorStop(0.14, "rgba(74,62,66,0.9)");
      kg.addColorStop(1.00, "rgba(30,27,34,1)");
      ctx.fillStyle = kg;
      ctx.fill();

      // The lit top edge of the kerb, running to the vanishing point. One
      // hairline, and the eye reads a whole street.
      ctx.beginPath();
      const a = P(kerbIn, 0.035, zN), b = P(kerbIn, 0.035, zF);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = "rgba(226,196,158,0.20)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------ the road */

  function roadPath() {
    ctx.beginPath();
    const nl = P(-1, 0, 0.92), nr = P(1, 0, 0.92);
    const fl = P(-1, 0, 200), fr = P(1, 0, 200);
    ctx.moveTo(nl.x, height + 10);
    ctx.lineTo(nr.x, height + 10);
    ctx.lineTo(fr.x, fr.y);
    ctx.lineTo(fl.x, fl.y);
    ctx.closePath();
  }

  function drawRoad(time) {
    const y0 = height, y1 = horizonY();
    roadPath();

    const surface = ctx.createLinearGradient(0, y1, 0, y0);
    surface.addColorStop(0.00, "#6A574C");
    surface.addColorStop(0.08, "#39323E");
    surface.addColorStop(0.30, "#1F1F2D");
    surface.addColorStop(0.68, "#14141E");
    surface.addColorStop(1.00, "#0B0B12");
    ctx.fillStyle = surface;
    ctx.fill();

    ctx.save();
    roadPath();
    ctx.clip();

    if (grainPat) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = grainPat;
      ctx.fillRect(0, y1, width, y0 - y1);

      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.28;
      ctx.fillRect(0, y1, width, (y0 - y1) * 0.55);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    drawWheelPaths();
    drawPatches();
    drawJoints();
    drawReflection(time);

    ctx.globalCompositeOperation = "lighter";
    const rake = ctx.createLinearGradient(width, y1, width * 0.12, y0);
    rake.addColorStop(0, "rgba(255,164,84,0.09)");
    rake.addColorStop(0.55, "rgba(180,110,70,0.03)");
    rake.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rake;
    ctx.fillRect(0, y1, width, y0 - y1);
    ctx.restore();
  }

  function drawWheelPaths() {
    // Four polished bands where tyres have run for years. They are barely
    // visible and they are the reason the surface reads as used.
    const zN = 0.92, zF = 90;
    for (const u of [-0.72, -0.30, 0.30, 0.72]) {
      const w = 0.115;
      quad(P(u - w, 0, zN), P(u + w, 0, zN), P(u + w, 0, zF), P(u - w, 0, zF));
      const g = ctx.createLinearGradient(0, yAt(zF), 0, height);
      g.addColorStop(0.00, "rgba(255,214,170,0.000)");
      g.addColorStop(0.26, "rgba(255,214,170,0.020)");
      g.addColorStop(1.00, "rgba(255,214,170,0.010)");
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  function drawPatches() {
    // Repairs, oil and ironwork. A carriageway with none of these is a
    // ramp in a rendering; every real one is a record of everything ever
    // done to it, and cracks are only the newest entry.
    const gap = 6.7;
    const first = Math.ceil((travel + 0.9) / gap);
    for (let i = first; i < first + 16; i++) {
      const z = i * gap - travel + hash(i, 41) * 3;
      if (z > 40) break;
      if (z < 0.9) continue;
      const fog = fogOf(z);
      if (fog > 0.75) continue;
      const kind = hash(i, 42);

      if (kind < 0.45) {
        // A cut-and-fill patch: newer, darker, squarer than what it is in.
        const u = (hash(i, 43) - 0.5) * 1.5;
        const w = 0.16 + hash(i, 44) * 0.34, d = 0.5 + hash(i, 45) * 1.3;
        const p1 = P(u - w, 0, z), p2 = P(u + w, 0, z);
        const p3 = P(u + w * 1.08, 0, z + d), p4 = P(u - w * 1.06, 0, z + d);
        quad(p1, p2, p3, p4);
        ctx.fillStyle = "rgba(6,6,11," + (0.34 * (1 - fog)).toFixed(3) + ")";
        ctx.fill();
        ctx.strokeStyle = "rgba(178,152,124," + (0.10 * (1 - fog)).toFixed(3) + ")";
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (kind < 0.72) {
        // Oil, dropped where traffic stands. No edge at all.
        const u = (hash(i, 46) - 0.5) * 1.1;
        const c = P(u, 0, z);
        const rr = halfAt(z) * (0.10 + hash(i, 47) * 0.16);
        ctx.save();
        ctx.translate(c.x, c.y); ctx.scale(1, 0.22);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
        g.addColorStop(0, "rgba(4,4,8," + (0.40 * (1 - fog)).toFixed(3) + ")");
        g.addColorStop(1, "rgba(4,4,8,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, 6.283); ctx.fill();
        ctx.restore();
      } else {
        // A manhole, ringed and slightly proud of the surface.
        const u = (hash(i, 48) < 0.5 ? -1 : 1) * (0.42 + hash(i, 49) * 0.3);
        const c = P(u, 0, z);
        const rr = halfAt(z) * 0.085;
        ctx.save();
        ctx.translate(c.x, c.y); ctx.scale(1, 0.30);
        ctx.fillStyle = "rgba(10,10,15," + (0.75 * (1 - fog)).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, 6.283); ctx.fill();
        ctx.strokeStyle = "rgba(198,172,142," + (0.16 * (1 - fog)).toFixed(3) + ")";
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(0, -rr * 0.12, rr * 0.94, Math.PI, 6.283); ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawJoints() {
    // Transverse construction joints, scrolling with the road. They are the
    // clearest cue that the ground is moving under the camera.
    // A joint is a saw cut that has been filled, re-cracked and worn: it
    // wanders, it fades in and out along its length, and it is never the
    // same width twice. Drawn as one ruled line it looks like a mistake in
    // the artwork, which is exactly what the first version looked like.
    const gap = 5.5;
    const first = Math.ceil((travel + 2.2) / gap);
    ctx.save();
    ctx.lineCap = "round";
    for (let i = first; i < first + 22; i++) {
      const z = i * gap - travel + hash(i, 71) * 1.2;
      if (z > 70) break;
      if (z < 1.6) continue;
      const fog = fogOf(z);
      const strength = (1 - fog) * (0.5 + hash(i, 72) * 0.5);
      ctx.lineWidth = Math.max(0.5, halfAt(z) * 0.0045);
      const segs = 9;
      for (let j = 0; j < segs; j++) {
        const uA = -1.0 + (2.0 * j) / segs, uB = -1.0 + (2.0 * (j + 1)) / segs;
        const wob = (hash(i * 17 + j, 73) - 0.5) * 0.055;
        const a = P(uA, 0, z + wob), b = P(uB, 0, z + wob * 0.6);
        const on = 0.10 + hash(i * 17 + j, 74) * 0.26;
        ctx.strokeStyle = "rgba(0,0,0," + (on * strength).toFixed(3) + ")";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawReflection(time) {
    const cx = sunX(), y1 = horizonY();
    if (!sheen) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(sheen, 0, 0);

    // A slow swell along its length, so it breathes instead of sitting
    // still. Nine gradients, which is cheap; the sheen underneath is the
    // part that had to be pre-rendered.
    if (!still) {
      for (let i = 0; i < 9; i++) {
        const t = (i / 9 + (time / 9000) % 1) % 1;
        const y = y1 + (height - y1) * t;
        const w = width * (0.020 + 0.26 * Math.pow(t, 1.15));
        const swell = ctx.createLinearGradient(cx - w, 0, cx + w, 0);
        const a = 0.028 * (1 - t);
        swell.addColorStop(0, "rgba(255,214,158,0)");
        swell.addColorStop(0.5, "rgba(255,214,158," + a.toFixed(4) + ")");
        swell.addColorStop(1, "rgba(255,214,158,0)");
        ctx.fillStyle = swell;
        ctx.fillRect(cx - w, y, w * 2, (height - y1) * 0.06);
      }
    }
    ctx.restore();
  }

  function drawEdgeLines() {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      for (let z = 0.95; z < 160; z *= 1.055) {
        const p = P(0.93 * side, 0, z);
        if (z === 0.95) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(236,214,176,0.20)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawLaneDashes() {
    const gap = 2.4, dash = 1.25;
    const first = Math.ceil((travel + 0.92 - dash) / gap);
    for (let i = first; i < first + 60; i++) {
      let near = i * gap - travel;
      const far = near + dash;
      if (far <= 0.92) continue;
      if (near < 0.92) near = 0.92;
      const cNear = P(0, 0, near), cFar = P(0, 0, far);
      if (cNear.y - cFar.y < 0.35) break;
      const wNear = halfAt(near) * 0.019 + 0.4;
      const wFar = halfAt(far) * 0.019 + 0.3;
      ctx.globalAlpha = Math.max(0, Math.min(1, (near - 0.92) / 2.6)) * 0.80;
      ctx.fillStyle = "rgba(244,230,200,0.60)";
      ctx.beginPath();
      ctx.moveTo(cNear.x - wNear, cNear.y);
      ctx.lineTo(cNear.x + wNear, cNear.y);
      ctx.lineTo(cFar.x + wFar, cFar.y);
      ctx.lineTo(cFar.x - wFar, cFar.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* -------------------------------------------------------------- cracks */

  function crackOutline(c, upTo) {
    // Two offset walks, out along one side and back along the other, so the
    // result is a closed shape whose width varies — the fissure, not a line.
    const n = c.spine.length;
    const last = Math.max(1, Math.min(n - 1, Math.floor((n - 1) * upTo)));
    const left = [], right = [];
    for (let i = 0; i <= last; i++) {
      const p = c.spine[i];
      const z = p.s - travel;
      if (z < 0.80) continue;
      const q = c.spine[Math.min(n - 1, i + 1)];
      const r = c.spine[Math.max(0, i - 1)];
      let du = q.u - r.u, ds = q.s - r.s;
      const m = Math.hypot(du, ds) || 1;
      // Normal in world units, so the crack keeps its width in metres and
      // narrows on screen purely because of distance.
      const nu = (ds / m) * c.wid[i], ns = (-du / m) * c.wid[i];
      left.push(P(p.u + nu, 0, Math.max(0.80, z + ns)));
      right.push(P(p.u - nu, 0, Math.max(0.80, z - ns)));
    }
    if (left.length < 2) return null;
    const path = new Path2D();
    path.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) path.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) path.lineTo(right[i].x, right[i].y);
    path.closePath();
    return { path: path, head: left[left.length - 1], tail: left[0] };
  }

  function drawOneCrack(c, time) {
    const upTo = c.open;
    if (upTo <= 0.01) return;
    const shape = crackOutline(c, upTo);
    if (!shape) return;

    const zMid = (c.spine[0].s + c.spine[c.spine.length - 1].s) / 2 - travel;
    const fog = fogOf(Math.max(0.9, zMid));
    const vis = 1 - fog;
    if (vis < 0.06) return;

    ctx.save();

    // Spall: the crumbled lip either side, lighter than the road because
    // fresh aggregate is exposed. Drawn wide and soft, under everything.
    ctx.globalAlpha = 0.34 * vis;
    ctx.strokeStyle = "rgba(196,168,140,0.55)";
    ctx.lineWidth = Math.max(1.4, halfAt(Math.max(1, zMid)) * 0.020);
    ctx.lineJoin = "round";
    ctx.stroke(shape.path);

    // A dark bruise around it — asphalt near a crack is always stained.
    ctx.globalAlpha = 0.40 * vis;
    ctx.strokeStyle = "rgba(8,7,12,0.75)";
    ctx.lineWidth = Math.max(2.2, halfAt(Math.max(1, zMid)) * 0.034);
    ctx.stroke(shape.path);

    // The void itself.
    ctx.globalAlpha = Math.min(1, 0.55 + vis * 0.45);
    ctx.fillStyle = "#07070B";
    ctx.fill(shape.path);

    // The lit lip on the sun's side, one pixel off. That pair — bright edge
    // above, black below — is the whole trick of depth on a flat surface.
    ctx.globalAlpha = 0.5 * vis;
    ctx.strokeStyle = "rgba(255,206,150,0.5)";
    ctx.lineWidth = 1;
    ctx.save();
    ctx.translate(0, -1.1);
    ctx.stroke(shape.path);
    ctx.restore();

    ctx.globalAlpha = 1;

    // Spurs, as plain tapering strokes: they are always hairline.
    ctx.lineCap = "round";
    for (const sp of c.spurs) {
      if (sp[0].s - travel < 0.85) continue;
      const grow = Math.max(0, Math.min(1, (upTo - 0.35) / 0.5));
      if (grow <= 0.02) continue;
      const upto = Math.max(1, Math.floor(sp.length * grow));
      ctx.beginPath();
      for (let i = 0; i < upto; i++) {
        const z = Math.max(0.82, sp[i].s - travel);
        const p = P(sp[i].u, 0, z);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(9,8,13," + (0.85 * vis).toFixed(3) + ")";
      ctx.lineWidth = Math.max(0.7, halfAt(Math.max(1, zMid)) * 0.006);
      ctx.stroke();
    }

    // Map cracking: a small polygonal net where the surface has given up.
    if (c.web >= 0 && upTo > 0.6) {
      const node = c.spine[Math.min(c.spine.length - 1, c.web)];
      const z = node.s - travel;
      if (z > 0.9) {
        const k = halfAt(z);
        if (k * 0.1 > 3) {
          ctx.save();
          ctx.strokeStyle = "rgba(10,9,14," + (0.62 * vis).toFixed(3) + ")";
          ctx.lineWidth = Math.max(0.6, k * 0.0045);
          for (let i = 0; i < 7; i++) {
            const a0 = i * 0.9 + node.u * 3;
            const r0 = 0.035 + (i % 3) * 0.022;
            const p1 = P(node.u + Math.cos(a0) * r0, 0, z + Math.sin(a0) * r0 * 1.6);
            const p2 = P(node.u + Math.cos(a0 + 2.1) * r0 * 1.3, 0, z + Math.sin(a0 + 2.1) * r0 * 2.1);
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    ctx.restore();
    c.shape = shape;
    c.zMid = zMid;
  }

  function drawCracks(time, dt) {
    recycleCracks();
    for (const c of cracks) {
      const zMid = (c.s0 + c.s1) / 2 - travel;
      if (!c.opening && zMid < c.trigger) c.opening = true;
      if (still) c.open = 1;
      else if (c.opening && c.open < 1) c.open = Math.min(1, c.open + dt / 2.6);
      c.zMid = zMid;
    }
    // Far ones first, so a near crack overlaps a far one correctly.
    const order = cracks.slice().sort(function (a, b) { return b.zMid - a.zMid; });
    for (const c of order) drawOneCrack(c, time);
  }

  /* ------------------------------------------------------- the read-out */

  function drawReticle(time) {
    // What the vehicle is actually doing: it has found one, and it is
    // measuring it. Deliberately thin — an instrument, not a heads-up
    // display. It picks whichever crack is nearest the sweet spot and lets
    // go of it as that crack passes underneath.
    let best = null, bestScore = 1e9;
    for (const c of cracks) {
      if (!c.shape || c.open < 0.75) continue;
      const z = c.zMid;
      if (z < 1.5 || z > 6.5) continue;
      const score = Math.abs(z - 3.2);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best || !best.shape) return;

    const fade = Math.max(0, Math.min(1, (6.5 - best.zMid) / 1.6)) *
                 Math.max(0, Math.min(1, (best.zMid - 1.5) / 1.0));
    if (fade < 0.03) return;

    // Bounding box of the visible part of the spine.
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const n = best.spine.length;
    for (let i = 0; i < n; i++) {
      const z = best.spine[i].s - travel;
      if (z < 1.0) continue;
      const p = P(best.spine[i].u, 0, z);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    if (x1 - x0 < 6 || y1 - y0 < 6) return;
    const pad = 14;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;

    const arm = Math.min(26, Math.min(x1 - x0, y1 - y0) * 0.28);
    ctx.save();
    ctx.globalAlpha = fade * 0.62;
    ctx.strokeStyle = "rgba(233,168,72,0.9)";
    ctx.lineWidth = 1;
    const corners = [
      [x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1],
    ];
    for (const c of corners) {
      ctx.beginPath();
      ctx.moveTo(c[0] + c[2] * arm, c[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] + c[3] * arm);
      ctx.stroke();
    }

    ctx.globalAlpha = fade * 0.85;
    ctx.font = "600 10px ui-monospace,'SFMono-Regular',Menlo,monospace";
    ctx.fillStyle = "rgba(240,200,140,0.95)";
    ctx.textBaseline = "bottom";
    const label = best.len_mm + " mm";
    ctx.fillText(label, x0 + 1, y0 - 5);
    ctx.globalAlpha = fade * 0.4;
    ctx.fillStyle = "rgba(233,168,72,0.9)";
    ctx.fillRect(x0 + 1, y0 - 3, ctx.measureText(label).width, 1);
    ctx.restore();
  }

  /* ------------------------------------------------------------- traffic */

  // Two vehicles, a long way off, seen only as tail lights. They cost
  // almost nothing to draw and they do something no amount of texture can:
  // they say the street is in use, and they put a scale on the distance.
  const TRAFFIC = [
    { s: 34, u: 0.52, speed: 1.35 },
    { s: 61, u: 0.66, speed: 1.05 },
  ];

  function drawTraffic(dt) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const v of TRAFFIC) {
      if (!still) v.s += (v.speed - SPEED) * dt;
      let z = v.s - travel;
      if (z < 18) { v.s = travel + 62 + Math.random() * 22; z = v.s - travel; }
      if (z > 82) continue;
      const fog = fogOf(z);
      const k = halfAt(z);
      const a = (1 - fog) * 0.9;
      if (a < 0.05) continue;

      for (const side of [-1, 1]) {
        const p = P(v.u + side * 0.055, 0.055, z);
        const r = Math.max(1.6, k * 0.030);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0.00, "rgba(255,120,86," + (0.85 * a).toFixed(3) + ")");
        g.addColorStop(0.28, "rgba(226,54,34," + (0.30 * a).toFixed(3) + ")");
        g.addColorStop(1.00, "rgba(180,20,10,0)");
        ctx.fillStyle = g;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
      // The smear the pair throws down onto the wet-looking tarmac.
      const p = P(v.u, 0, z);
      const rr = Math.max(3, k * 0.075);
      ctx.save();
      ctx.translate(p.x, p.y); ctx.scale(1, 0.34);
      const gg = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
      gg.addColorStop(0, "rgba(220,64,38," + (0.16 * a).toFixed(3) + ")");
      gg.addColorStop(1, "rgba(200,40,20,0)");
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, 6.283); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------- air, finish */

  function drawHaze() {
    const cx = sunX(), cy = horizonY();
    const pool = ctx.createRadialGradient(cx, cy, 0, cx, cy, width * 0.62);
    pool.addColorStop(0.00, "rgba(226,132,52,0.17)");
    pool.addColorStop(0.30, "rgba(160,80,44,0.06)");
    pool.addColorStop(1.00, "rgba(60,40,70,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    const top = horizonY() - height * 0.10;
    const fog = ctx.createLinearGradient(0, top, 0, horizonY() + height * 0.13);
    fog.addColorStop(0.00, "rgba(112,98,142,0)");
    fog.addColorStop(0.42, "rgba(120,102,140,0.17)");
    fog.addColorStop(0.56, "rgba(126,104,132,0.22)");
    fog.addColorStop(1.00, "rgba(96,86,132,0)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, top, width, height * 0.24);
  }

  const motes = (function () {
    const out = [];
    for (let i = 0; i < 46; i++) {
      out.push({
        x: Math.random(), y: Math.random(),
        r: 0.4 + Math.random() * 1.5,
        drift: 0.004 + Math.random() * 0.016,
        sway: Math.random() * 6.283,
        alpha: 0.06 + Math.random() * 0.19,
      });
    }
    return out;
  })();

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
    const vignette = ctx.createRadialGradient(
      sunX(), horizonY(), Math.min(width, height) * 0.16,
      width * 0.5, height * 0.55, Math.max(width, height) * 0.80);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(0.58, "rgba(6,6,12,0.22)");
    vignette.addColorStop(1, "rgba(4,4,9,0.76)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    if (dither) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = ditherPat;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
  }

  /* --------------------------------------------------------------- frame */

  // World units a second. One unit is a little over four metres, so this
  // is about eighteen kilometres an hour: the speed a municipal survey
  // vehicle actually works at, and slow enough to read a crack as it goes
  // past rather than watching it flick by.
  const SPEED = 1.15;

  function draw(dt) {
    if (!width || !height) return;
    const time = performance.now();
    const step = dt || 0;

    updateCamera(time);

    ctx.clearRect(0, 0, width, height);
    // Roll is a rotation of the frame, not of anything in the world, so it
    // wraps every world pass and stops before the lens effects — a
    // vignette that tilts with the body would be a vignette painted on the
    // windscreen. The slight overscan keeps the corners covered.
    ctx.save();
    if (camRoll) {
      ctx.translate(width / 2, height / 2);
      ctx.rotate(camRoll);
      ctx.scale(1.012, 1.012);
      ctx.translate(-width / 2, -height / 2);
    }
    drawSky();
    drawStars(time);
    drawClouds(time);
    drawGodRays(time);
    drawSun(time);
    drawGround();
    drawCity(time);
    const lamps = drawLamps();
    drawTrees();
    drawPavement();
    drawRoad(time);
    drawEdgeLines();
    drawLaneDashes();
    drawHaze();
    drawCracks(time, step);
    drawLampGlow(lamps);
    drawTraffic(step);
    drawReticle(time);
    drawMotes(time);
    ctx.restore();
    drawFinish();
  }

  function frame(time) {
    if (!running) return;
    const dt = lastFrame ? Math.min(0.1, (time - lastFrame) / 1000) : 0;
    if (lastFrame) {
      budget = budget * 0.94 + Math.min(120, time - lastFrame) * 0.06;
      if (rich && budget > 34) rich = false;        // below ~30fps: shed detail
      else if (!rich && budget < 22) rich = true;   // comfortably back: restore
    }
    lastFrame = time;
    if (!still) travel += SPEED * dt;
    draw(dt);
    requestAnimationFrame(frame);
  }

  function shouldRun() {
    const page = document.getElementById("p0");
    return !still && document.visibilityState === "visible" &&
           page && page.classList.contains("on");
  }

  function sync() {
    const box = canvas.getBoundingClientRect();
    if (box.width >= 2 && Math.abs(box.width - width) > 1) resize();

    const want = shouldRun();
    if (want && !running) {
      running = true;
      lastFrame = 0;
      requestAnimationFrame(frame);
    } else if (!want) {
      running = false;
      if (!still) draw(0);
    }
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", sync);

  resize();
  sync();

  window.RoadHero = { sync: sync };
})();
