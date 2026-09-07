"use strict";

/* =========================================================================
   RAAHI · browser side
   ---------------------------------------------------------------------
   The browser does one job well: find the crack in a photograph and
   measure it in pixels. Everything that needs to be remembered — where
   the photo was taken, whether this is yesterday's crack, how fast it is
   growing — is the backend's job, because those answers have to survive
   a closed tab.
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const UI = {
  siteId: null,          // spot currently shown on the GROWTH tab
  reportId: null,        // spot currently shown on the REPORT tab
  autoShutter: false,    // did the shutter press itself for the photo on screen
  roadClasses: [],       // the traffic table, fetched once
  sites: [],
  threshold: 150,
  lastResult: null,      // what the detector found in the photo on screen
  lastPhoto: null,       // { b64, filename } — original bytes, EXIF intact
  devicePosition: null,  // browser geolocation, used when a photo has none
};

/* ==================== TALKING TO THE BACKEND ==================== */
async function api(path, options) {
  const response = await fetch("/api" + path, Object.assign({
    headers: { "Content-Type": "application/json" },
  }, options || {}));
  let payload = {};
  try { payload = await response.json(); } catch (e) { payload = {}; }
  if (!response.ok) throw new Error(payload.error || ("Request failed: " + response.status));
  return payload;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const del = (path) => api(path, { method: "DELETE" });

/* ==================== MESSAGES ==================== */
function toast(message, kind) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText = "position:fixed;top:20px;right:20px;z-index:9999;max-width:400px";
    document.body.appendChild(el);
  }
  el.className = "note " + (kind || "bad");
  el.innerHTML = esc(message);
  el.style.display = "block";
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = "none"; }, 5200);
}

function say(hostId, message, kind) {
  const host = $(hostId);
  if (host) host.innerHTML = '<div class="note ' + (kind || "ok") + '">' + message + "</div>";
}

/* ==================== IMAGE ANALYSIS ====================
   Threshold, clean up, label the connected pieces, then score each one on
   how crack-shaped it is: thin, near the middle of the frame, not running
   off the edge. The highest scoring piece is the crack.                  */
function analyseImage(imgEl, threshold, maxWidth) {
  const MAX_WIDTH = maxWidth || 760;
  const sourceWidth = imgEl.naturalWidth || imgEl.videoWidth;
  const sourceHeight = imgEl.naturalHeight || imgEl.videoHeight;
  if (!sourceWidth || !sourceHeight) return { err: "No image data available." };

  const scale = Math.min(1, MAX_WIDTH / sourceWidth);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const mask = new Uint8Array(width * height);
  const grayscale = new Uint8Array(width * height);
  let graySum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    grayscale[p] = gray;
    graySum += gray;
    mask[p] = gray < threshold ? 1 : 0;
  }
  const sceneMean = graySum / (width * height);

  const dilated = new Uint8Array(width * height);
  const eroded = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let value = 0;
      for (let dy = -1; dy < 2 && !value; dy++) {
        for (let dx = -1; dx < 2; dx++) {
          if (mask[(y + dy) * width + (x + dx)]) { value = 1; break; }
        }
      }
      dilated[y * width + x] = value;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let value = 1;
      for (let dy = -1; dy < 2 && value; dy++) {
        for (let dx = -1; dx < 2; dx++) {
          if (!dilated[(y + dy) * width + (x + dx)]) { value = 0; break; }
        }
      }
      eroded[y * width + x] = value;
    }
  }

  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const candidates = [];
  let numLabels = 0;
  const centerX = width / 2, centerY = height / 2;
  const diagonal = Math.hypot(width, height);

  for (let p = 0; p < width * height; p++) {
    if (!eroded[p] || labels[p]) continue;
    numLabels++;
    let sp = 0;
    stack[sp++] = p; labels[p] = numLabels;
    let area = 0, minX = width, maxX = 0, minY = height, maxY = 0, sumX = 0, sumY = 0;
    const pixels = [];
    while (sp > 0) {
      const q = stack[--sp];
      area++; pixels.push(q);
      const qy = Math.floor(q / width), qx = q - qy * width;
      sumX += qx; sumY += qy;
      if (qx < minX) minX = qx;
      if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy;
      if (qy > maxY) maxY = qy;
      for (let dy = -1; dy < 2; dy++) {
        for (let dx = -1; dx < 2; dx++) {
          const ny = qy + dy, nx = qx + dx;
          if (ny >= 0 && nx >= 0 && ny < height && nx < width) {
            const r = ny * width + nx;
            if (eroded[r] && !labels[r]) { labels[r] = numLabels; stack[sp++] = r; }
          }
        }
      }
    }
    if (area < 180) continue;

    let perimeter = 0;
    for (const q of pixels) {
      const qy = Math.floor(q / width), qx = q - qy * width;
      if (qx === 0 || qy === 0 || qx === width - 1 || qy === height - 1 ||
          !eroded[q - 1] || !eroded[q + 1] || !eroded[q - width] || !eroded[q + width]) perimeter++;
    }
    const arcLength = perimeter / 2;
    const span = Math.hypot(maxX - minX, maxY - minY);
    const thinness = (perimeter * perimeter) / area;
    const touchesBorder = (minX <= 2 || minY <= 2 || maxX >= width - 3 || maxY >= height - 3);
    const offset = Math.hypot(sumX / area - centerX, sumY / area - centerY) / diagonal;
    const score = thinness * (1 / (1 + 3.2 * offset)) * (touchesBorder ? 0.18 : 1);

    // A crack is thin, long, and does not cover the photograph. Speckle from
    // a grainy road surface fails all three, and without this guard it wins
    // on thinness alone — a thousand scattered dots have an enormous
    // perimeter for their area.
    const areaFraction = area / (width * height);
    const wander = arcLength / Math.max(span, 1);
    const plausible = areaFraction < 0.06 && wander < 4.5 &&
                      span > 0.06 * diagonal && area > 220;

    // How much darker this shape is than the road around it. A crack is a
    // hole in the surface and reads far darker; speckle that only just
    // crossed the threshold barely differs from its surroundings.
    let darkSum = 0;
    for (const q of pixels) darkSum += grayscale[q];
    const contrast = Math.max(0, sceneMean - darkSum / area) / 255;

    candidates.push({ pixels, arcLength, span, area, score, touchesBorder, plausible,
                      areaFraction, wander, contrast,
                      straightness: span / Math.max(arcLength, 1), minX, maxX, minY, maxY });
  }

  if (!candidates.length) return { err: "Nothing dark enough was found in this photo." };
  // Anything crack-shaped comes first; the rest stay available behind
  // "next candidate" in case the guard was wrong about a real crack.
  candidates.sort((a, b) => (b.plausible - a.plausible) ||
                           (b.contrast * b.span - a.contrast * a.span) ||
                           (b.score - a.score));

  function paint(index) {
    const candidate = candidates[Math.min(index, candidates.length - 1)];
    const out = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
    for (const q of candidate.pixels) {
      const i = q * 4;
      out.data[i] = 235; out.data[i + 1] = 70; out.data[i + 2] = 60; out.data[i + 3] = 255;
    }
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    const cx = c.getContext("2d");
    cx.putImageData(out, 0, 0);
    cx.strokeStyle = "#5FA86B"; cx.lineWidth = 2; cx.setLineDash([7, 5]);
    cx.strokeRect(candidate.minX - 7, candidate.minY - 7,
                  candidate.maxX - candidate.minX + 14, candidate.maxY - candidate.minY + 14);
    return c;
  }

  return { candidates, paint, width, height };
}

/* Sweep the threshold so nobody has to drag a slider to get a result.

   Raising the threshold always finds more dark pixels, so the naive "best
   score" picks the darkest setting and returns the whole photograph. The
   sweep therefore only considers thresholds that leave a crack-shaped
   thing behind, and takes the longest one of those. */
function autoAnalyse(imgEl) {
  let best = null, bestThreshold = 110, bestMerit = 0;
  const merit = (c, result) => c.contrast * (c.span / Math.hypot(result.width, result.height));
  for (let t = 70; t <= 180; t += 10) {
    const result = analyseImage(imgEl, t);
    if (result.err || !result.candidates.length) continue;
    const top = result.candidates[0];
    if (!top.plausible) continue;
    const value = merit(top, result);
    if (value > bestMerit) { best = result; bestThreshold = t; bestMerit = value; }
  }
  if (best) return { result: best, threshold: bestThreshold };

  // Nothing crack-shaped anywhere in the sweep. Fall back to a middling
  // threshold and let the person look at what it found.
  return { result: analyseImage(imgEl, 110), threshold: 110 };
}

/* A 32x32 grayscale grid. The backend turns it into the 64-bit fingerprint
   that recognises this scene again tomorrow. */
function lumaGrid(imgEl, size) {
  size = size || 32;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const grid = new Array(size * size);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    grid[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  return grid;
}

/* ==================== CAMERA & FILES ==================== */
let mediaStream = null, cameraHost = null, cameraWatchStop = null;

function stopCamera() {
  if (cameraWatchStop) { cameraWatchStop(); cameraWatchStop = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (cameraHost) {
    const host = $(cameraHost);
    if (host) host.innerHTML = "";
    cameraHost = null;
  }
}

function startCamera(hostId, onFrame) {
  if (cameraHost === hostId && mediaStream) return;
  stopCamera();
  const host = $(hostId);
  if (!host) return;
  cameraHost = hostId;

  if (!window.isSecureContext) {
    host.innerHTML = '<div class="note warn"><b>The camera needs the local server.</b><br>' +
      'Run <span class="mono">python3 server.py</span> and open ' +
      '<b>http://localhost:8000</b>. Uploading a photo works either way — and an ' +
      'uploaded phone photo carries GPS, which a webcam frame does not.</div>';
    return;
  }

  host.innerHTML = '<video autoplay playsinline muted style="width:100%;border-radius:10px;' +
    'border:1px solid var(--edge)"></video>' +
    '<label class="shutterrow"><input type="checkbox" id="autoshutter" checked>' +
    "<span>Fire the shutter when it sees a crack</span></label>" +
    '<div class="shutterstate" id="shutterstate">Camera starting…</div>' +
    '<button class="btn g" style="margin-top:12px">TAKE THE PHOTO</button>';
  const video = host.querySelector("video");
  const button = host.querySelector("button");
  const state = $("shutterstate");

  navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1600 } } })
    .then((stream) => { mediaStream = stream; video.srcObject = stream; watch(); })
    .catch(() => {
      host.innerHTML = '<div class="note bad">The camera is blocked. Allow it in the browser, ' +
        "or upload a photo instead.</div>";
    });

  /* Take the frame that is on screen right now, at full resolution. */
  function fire(auto) {
    if (!video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const img = new Image();
    img.onload = () => onFrame(img, {
      b64: dataUrl,
      filename: (auto ? "autoshutter" : "capture") + "-" + Date.now() + ".jpg",
      live: true, auto: !!auto,
    });
    img.src = dataUrl;
  }

  button.addEventListener("click", () => fire(false));

  /* ---- the shutter that presses itself --------------------------------
     A driver on a collection round has both hands on the wheel, so nobody
     is going to press anything. The camera watches its own preview and
     fires when a crack is in front of it.

     Two rules keep it from firing at every dark patch on the road:

       * the frame has to hold something crack-shaped — the same test the
         still detector uses: thin, long, not filling the picture, and
         clearly darker than the tarmac around it;
       * it has to be there in three frames running. A shadow crossing the
         lens, a wet patch, a passing wheel: all gone by the next frame.

     Frames are checked small and slow — a little over half the working
     width, once a second — because this runs on a phone with the screen off
     and the live pass only has to decide whether the picture is worth
     keeping. The full-resolution frame is what actually gets measured.

     Not smaller than that, though: a crack is two or three pixels wide in
     the photograph, and below about 400 px across it thins out until the
     connected-component step finds nothing at all. A watcher that never
     fires is worse than no watcher. */
  const WATCH_WIDTH = 420;
  let stableFor = 0, armed = true, timer = null;

  function watch() {
    clearInterval(timer);
    timer = setInterval(look, 900);
    if (state) state.textContent = "Watching the road…";
  }

  function look() {
    if (!mediaStream || !video.videoWidth) return;
    const auto = $("autoshutter");
    if (!auto || !auto.checked) {
      stableFor = 0;
      if (state) state.textContent = "Automatic shutter off — press the button yourself.";
      return;
    }
    if (!armed) return;

    // Road lighting is nothing like a fixed number — wet tarmac, low sun,
    // the shadow of the truck itself. So sweep a few cuts and keep the one
    // with the most contrast, which is the cheap version of what the still
    // detector does with the full sweep.
    let top = null, merit = 0;
    for (const cut of [95, 120, 145]) {
      const found = analyseImage(video, cut, WATCH_WIDTH);
      if (found.err || !found.candidates.length) continue;
      const candidate = found.candidates[0];
      if (!candidate.plausible) continue;
      const value = candidate.contrast *
                    (candidate.span / Math.hypot(found.width, found.height));
      if (value > merit) { top = candidate; merit = value; }
    }
    const good = top && top.contrast > 0.055;

    if (!good) {
      stableFor = 0;
      if (state) state.textContent = "Watching the road — nothing crack-shaped yet.";
      return;
    }

    stableFor++;
    if (stableFor < 3) {
      if (state) {
        state.textContent = "Crack in frame — holding for a steady view (" +
          stableFor + " of 3).";
      }
      return;
    }

    stableFor = 0;
    armed = false;
    if (state) state.textContent = "SHUTTER — photograph taken and being measured.";
    fire(true);
    // Long enough not to photograph the same metre of road forty times while
    // the truck sits at a junction.
    setTimeout(() => {
      armed = true;
      if (state && mediaStream) state.textContent = "Watching the road…";
    }, 6000);
  }

  cameraWatchStop = () => clearInterval(timer);
}

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ img, photo: { b64: reader.result, filename: file.name,
                                                 live: false } });
      img.onerror = () => reject(new Error(file.name + " did not open as an image."));
      img.src = reader.result;   // the original bytes, so EXIF survives
    };
    reader.onerror = () => reject(new Error("Could not read " + file.name + "."));
    reader.readAsDataURL(file);
  });
}

function onFileChosen(input, callback) {
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    readPhoto(file).then(({ img, photo }) => callback(img, photo))
                   .catch((error) => toast(error.message));
  });
}

function showOnStage(stageId, canvas) {
  const stage = $(stageId);
  if (!stage) return;
  stage.innerHTML = "";
  canvas.style.opacity = "0";
  canvas.style.transition = "opacity .45s ease";
  stage.appendChild(canvas);
  const scan = document.createElement("div");
  scan.className = "scan";
  stage.appendChild(scan);
  requestAnimationFrame(() => { canvas.style.opacity = "1"; });
  setTimeout(() => scan.remove(), 2400);
}

function stageError(stageId, message) {
  const stage = $(stageId);
  if (stage) stage.innerHTML = '<div class="ph" style="color:var(--red)">' + esc(message) + "</div>";
}

/* Ask the browser where we are. Only matters for live capture and for
   photos that arrive with their GPS stripped. */
function askDevicePosition() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    UI.devicePosition = {
      lat: pos.coords.latitude, lon: pos.coords.longitude,
      accuracy_m: pos.coords.accuracy,
      heading_deg: (pos.coords.heading == null ? null : pos.coords.heading),
    };
  }, () => { /* declined; EXIF or manual entry still work */ },
     { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}

/* ==================== CAPTURE TAB ==================== */
let captureIndex = 0, captureThreshold = null, captureImage = null;

function runCapture(img, photo, keepIndex) {
  captureImage = img;
  if (photo) UI.lastPhoto = photo;
  if (photo) UI.autoShutter = !!photo.auto;
  if (!keepIndex) captureIndex = 0;

  let result;
  if (captureThreshold === null) {
    const auto = autoAnalyse(img);
    result = auto.result;
    $("t2").value = auto.threshold;
    $("t2v").textContent = "auto · " + auto.threshold;
    $("t2").style.setProperty("--p", ((auto.threshold - 40) / 170 * 100) + "%");
  } else {
    result = analyseImage(img, captureThreshold);
  }

  UI.lastResult = result;
  const cyclewrap = $("cyclewrap");
  cyclewrap.innerHTML = "";

  if (result.err) {
    stageError("stage", result.err);
    $("ro").style.display = "none";
    $("saveread").disabled = true;
    return;
  }

  showOnStage("stage", result.paint(captureIndex));
  const candidate = result.candidates[Math.min(captureIndex, result.candidates.length - 1)];
  $("saveread").disabled = false;
  $("saveread").textContent = "SAVE THIS READING";
  if (!candidate.plausible) {
    cyclewrap.innerHTML = '<div class="note warn">Nothing in this photo is shaped like a ' +
      "crack — what is outlined is the darkest thing found. Move closer, or open " +
      '<b>Adjust the detection</b> and move the threshold.</div>';
  }
  $("ro").style.display = "block";

  const cal = UI.calibration;
  if (cal && cal.mm_per_px) {
    let mmpp = cal.mm_per_px;
    if (cal.image_width && Math.abs(cal.image_width - result.width) > 4) {
      mmpp = mmpp * (cal.image_width / result.width);
    }
    $("mmv").textContent = (candidate.arcLength * mmpp).toFixed(0);
    $("mmu").textContent = "mm";
    $("scalenote").textContent = "Scale from the calibration recorded in the training tab.";
  } else {
    $("mmv").textContent = candidate.arcLength.toFixed(0);
    $("mmu").textContent = "px";
    $("scalenote").textContent =
      "Millimetres are worked out on the server from the lens data in the photo. " +
      "Save the reading to see them.";
  }

  if (result.candidates.length > 1) {
    cyclewrap.innerHTML += '<button class="btn ghost" id="cyc">Wrong shape? Next candidate (' +
      (captureIndex + 1) + " of " + result.candidates.length + ")</button>";
    $("cyc").addEventListener("click", () => {
      captureIndex = (captureIndex + 1) % UI.lastResult.candidates.length;
      runCapture(captureImage, null, true);
    });
  }
}

function readingPayload(img, photo, result, index, extra) {
  const candidate = result.candidates[Math.min(index || 0, result.candidates.length - 1)];
  const distanceCm = parseFloat($("dist").value);
  const dayField = parseInt($("dayno").value, 10);
  const named = dayFromName(photo ? photo.filename : "");
  return Object.assign({
    photo_b64: photo ? photo.b64 : null,
    filename: photo ? photo.filename : "",
    luma32: lumaGrid(img, 32),
    detection: {
      arc_px: candidate.arcLength,
      span_px: candidate.span,
      image_width: result.width,
      image_height: result.height,
      confidence: Math.round(candidate.contrast * 1000) / 1000,
    },
    device_gps: UI.devicePosition,
    distance_mm: isFinite(distanceCm) && distanceCm > 0 ? distanceCm * 10 : null,
    day_index: isFinite(dayField) && dayField > 0 ? dayField : named,
    new_spot: !!($("newspot") && $("newspot").checked),
    auto_shutter: !!(photo && photo.auto),
    captured_at: new Date().toISOString(),
  }, extra || {});
}

/* The same day number the backend reads out of a file name, read here too so
   the batch can show it before anything is sent. */
function dayFromName(filename) {
  const stem = String(filename || "").replace(/\.[^.]*$/, "");
  const found = stem.match(/(?:^|[^a-z0-9])(?:day|pass|round|visit|d)[\s_-]?0*(\d{1,3})(?:[^0-9]|$)/i);
  if (!found) return null;
  const value = parseInt(found[1], 10);
  return value >= 1 && value <= 999 ? value : null;
}

async function saveReading() {
  const result = UI.lastResult;
  if (!result || result.err || !captureImage) { toast("Take or upload a photo first."); return; }
  const button = $("saveread");
  button.disabled = true;
  button.textContent = "SAVING…";

  const forced = $("siteselect") ? $("siteselect").value : "";

  try {
    const payload = await post("/observations", readingPayload(
      captureImage, UI.lastPhoto, result, captureIndex, {
        label: $("rname").value.trim(),
        site_id: forced || null,
      }));

    renderPosition(payload);
    const site = payload.site;
    const length = payload.scale.length_mm;
    const measured = length != null ? length.toFixed(0) + " mm"
                                    : payload.scale.arc_px.toFixed(0) + " px (no scale yet)";
    if (length != null) { $("mmv").textContent = length.toFixed(0); $("mmu").textContent = "mm"; }
    if (payload.scale.source) $("scalenote").textContent = "Scale: " + payload.scale.source + ".";

    const headline = payload.revisit
      ? "<b>Same spot as before.</b> " + esc(site.name) + " — reading " +
        site.observations + ", measured " + measured + "."
      : "<b>New spot recorded.</b> " + esc(site.name) + " — baseline at " + measured + ".";
    say("msg", headline + '<div class="tiny" style="margin-top:8px">' +
        esc(payload.match.why) + "</div>", payload.revisit ? "ok" : "warn");
    if (payload.match.warning) {
      $("msg").innerHTML += '<div class="note warn">' + esc(payload.match.warning) + "</div>";
    }

    $("rname").value = "";
    if ($("newspot")) $("newspot").checked = false;
    await refreshAll();
    UI.siteId = site.id;
    renderGrowth();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "SAVE THIS READING";
  }
}

/* ==================== A FOLDER OF DAILY PASSES ====================
   Eighteen photographs of one crack, one a morning, uploaded in one go.
   They are measured and saved strictly in order, because the second photo
   of a spot has to find the first one already in the record before it can
   be recognised as the same place.

   Every file gets a line saying what happened to it. A file the detector
   cannot find a crack in is reported and skipped, not silently dropped —
   a missing day would bend the growth line and nobody would know why.   */
async function runBatch(files) {
  const host = $("batch");
  const ordered = [...files].sort((a, b) => {
    const da = dayFromName(a.name), db = dayFromName(b.name);
    if (da && db && da !== db) return da - db;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  host.innerHTML = '<div class="card" style="margin-top:16px"><h3>UPLOADING ' +
    ordered.length + " PHOTOGRAPHS</h3><div id=\"batchlines\"></div></div>";
  const lines = $("batchlines");
  const say2 = (text, kind) => {
    const row = document.createElement("div");
    row.className = "batchline " + (kind || "");
    row.innerHTML = text;
    lines.appendChild(row);
    lines.scrollTop = lines.scrollHeight;
  };

  $("pick").disabled = true;
  let saved = 0, skipped = 0, lastPayload = null, lastSeen = null, batchSite = null;
  for (let i = 0; i < ordered.length; i++) {
    const file = ordered[i];
    const counter = "<b>" + (i + 1) + "/" + ordered.length + "</b> " + esc(file.name) + " — ";
    try {
      const { img, photo } = await readPhoto(file);
      const auto = autoAnalyse(img);
      if (auto.result.err || !auto.result.candidates.length) {
        skipped++;
        say2(counter + "no crack found in this one. Skipped.", "warn");
        continue;
      }
      const payload = await post("/observations", readingPayload(img, photo, auto.result, 0, {
        label: "day " + (dayFromName(file.name) || (i + 1)),
        // A folder of photographs is a sequence, so number it as one. This is
        // only ever a fallback: the backend uses a day number solely when the
        // photograph carries no date of its own, so real phone photos keep
        // their real dates and this line changes nothing for them. Without it,
        // a set whose metadata was stripped lands on a single day and yields
        // no growth rate at all.
        day_index: dayFromName(file.name) || (i + 1),
        // Only the first photograph of a batch may open a new spot. Without
        // this the tick would apply to all of them and eighteen passes of one
        // crack would become eighteen separate cracks.
        new_spot: i === 0 && !!($("newspot") && $("newspot").checked),
        site_id: i > 0 && batchSite ? batchSite : null,
      }));
      if (i === 0) batchSite = payload.site.id;
      lastPayload = payload;
      lastSeen = { img: img, photo: photo, result: auto.result, threshold: auto.threshold };
      saved++;
      const mm = payload.scale.length_mm;
      const dated = payload.timing.source.indexOf("EXIF") !== -1;
      say2(counter + esc(payload.site.id) + " · " +
           (mm == null ? payload.scale.arc_px.toFixed(0) + " px" : mm.toFixed(1) + " mm") +
           " · " + (payload.revisit ? "same spot" : "new spot") +
           ' <span class="tiny">(' + (dated ? "dated by the photo"
                                            : esc(payload.timing.source)) + ")</span>",
           dated ? "ok" : "warn");
      // Let the browser paint between files; eighteen full-size images in a
      // tight loop otherwise freeze the tab for the whole upload.
      await new Promise((done) => setTimeout(done, 0));
    } catch (error) {
      skipped++;
      say2(counter + esc(error.message), "bad");
    }
  }
  $("pick").disabled = false;
  if ($("newspot")) $("newspot").checked = false;

  if (lastPayload) {
    renderPosition(lastPayload);
    UI.siteId = lastPayload.site.id;
  }

  // Show the last photograph with its crack outlined. Without this the
  // DETECTION panel sits empty after eighteen files have gone through it,
  // which reads as if nothing was detected in any of them.
  if (lastSeen) {
    captureImage = lastSeen.img;
    UI.lastPhoto = lastSeen.photo;
    UI.lastResult = lastSeen.result;
    captureIndex = 0;
    const candidate = lastSeen.result.candidates[0];
    showOnStage("stage", lastSeen.result.paint(0));
    $("ro").style.display = "block";
    const length = lastPayload.scale.length_mm;
    $("mmv").textContent = length == null ? candidate.arcLength.toFixed(0) : length.toFixed(0);
    $("mmu").textContent = length == null ? "px" : "mm";
    $("scalenote").textContent = "The last of " + saved + " photographs. Scale: " +
      (lastPayload.scale.source || "none yet") + ".";
    // It is already in the record. Saving again would file the same
    // photograph twice and flatten the last day of the curve.
    $("saveread").disabled = true;
    $("saveread").textContent = "ALREADY SAVED";
  }
  say2("<b>Done.</b> " + saved + " saved, " + skipped + " skipped.", saved ? "ok" : "warn");
  await refreshAll();
  renderGrowth();
  if (lastPayload) {
    say("msg", "<b>" + saved + " photographs saved.</b> Open <b>GROWTH</b> for the curve, " +
        "or <b>REPORT</b> for the whole record of this crack.", "ok");
  }
}

/* "2026-09-06T19:11:38.802Z" -> "2026-09-06 19:11:38". Milliseconds and a
   trailing Z are noise on a panel somebody reads with their eyes. */
function stampText(value) {
  if (!value) return "not recorded";
  return esc(String(value).replace("T", " ").slice(0, 19));
}

function renderPosition(payload) {
  const p = payload.position;
  const meta = payload.exif || {};
  const host = $("gpsbox");
  if (!p || p.lat == null) {
    host.innerHTML = '<div class="note warn"><b>No position on this photo.</b> ' +
      "It was saved anyway, and the fingerprint of the scene can still match it later. " +
      "For a position: use a photo straight off a phone with location on, or allow this " +
      "page to use your location before capturing.</div>";
    return;
  }
  const fromPhoto = String(p.source || "").indexOf("exif") === 0;
  const timing = payload.timing || {};
  const kv = [
    ["LATITUDE", p.lat == null ? "—" : (+p.lat).toFixed(6) + "°"],
    ["LONGITUDE", p.lon == null ? "—" : (+p.lon).toFixed(6) + "°"],
    ["DEG MIN SEC", esc(p.dms || "—")],
    ["ALTITUDE", p.altitude_m != null ? (+p.altitude_m).toFixed(1) + " m" : "not reported"],
    ["ACCURACY", p.accuracy_m != null ? "± " + (+p.accuracy_m).toFixed(1) + " m" : "not reported"],
    ["HEADING", p.heading_deg != null ? (+p.heading_deg).toFixed(0) + "° from true north"
                                      : "not reported"],
    ["SOURCE", fromPhoto ? "the photo's own EXIF" :
               p.source === "manual" ? "typed in" : "this device's GPS"],
    ["SHUTTER TIME", stampText(meta.taken_at || timing.captured_at)],
    ["GPS CLOCK (UTC)", meta.gps_time_utc ? stampText(meta.gps_time_utc) : "not in the file"],
    ["CAMERA", meta.make ? esc(meta.make + " " + (meta.model || "")) +
               (meta.written_by_raahi ? " (this app, at the shutter)" : "") : "not reported"],
    ["SPOT", esc(payload.site.id)],
    ["SCENE FINGERPRINT", esc(payload.fingerprint || "not computed")],
  ];

  // The line that answers "where does the number live?". Either the camera
  // wrote it, or we did — and if we did, say which tags went in.
  const stamp = p.written_into_photo
    ? '<div class="note ok" style="margin-top:12px"><b>Written into the file.</b> ' +
      esc(p.exif_note) + '<div class="tiny mono" style="margin-top:6px">' +
      esc((p.exif_tags || []).join(" · ")) + "</div></div>"
    : '<div class="tiny" style="margin-top:12px">' + esc(p.exif_note || "") + "</div>";

  host.innerHTML =
    '<div class="gps"><div><span class="srcpill ' + esc(fromPhoto ? "exif" : p.source) + '">' +
      (fromPhoto ? "from the photo" : p.source === "manual" ? "manual" : "from this device") +
    '</span></div>' +
    '<div class="coord">' + esc(p.text) + "</div>" +
    '<dl class="kv">' + kv.map((r) => "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>").join("") + "</dl>" +
    (p.map_url ? '<div><a href="' + esc(p.map_url) + '" target="_blank" rel="noopener">' +
                 "open this spot on a map →</a></div>" : "") +
    stamp +
    "</div>";
}

function renderSiteChooser() {
  const host = $("siteforce");
  if (!host) return;
  if (!UI.sites.length) { host.innerHTML = ""; return; }
  host.innerHTML = '<label class="f" for="siteselect">SPOT</label>' +
    '<select id="siteselect"><option value="">Work it out from the photo</option>' +
    UI.sites.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) +
                        " (" + s.observations + " photos)</option>").join("") + "</select>";
}

/* ==================== SPOTS TAB ==================== */
function thumb(sha, caption, value) {
  if (!sha) return '<div class="thumb"><div class="thumb miss">no photo</div></div>';
  return '<div class="thumb"><img src="/photo/' + esc(sha) + '" alt="" loading="lazy">' +
         '<div class="cap"><b>' + esc(value) + "</b><br>" + esc(caption) + "</div></div>";
}

function verdictPill(verdict) {
  const map = { "SEAL NOW": "p-now", "SEAL SOON": "p-soon", "MONITOR": "p-mon",
                "WATCH": "p-watch", "STABLE": "p-ok", "NO SCALE": "p-mon" };
  return '<span class="pill ' + (map[verdict] || "p-none") + '">' + esc(verdict) + "</span>";
}

/* A calendar date on its own. The seal-by line and the report headings are
   read as decisions, not timestamps, and "09 Sept 02:34 pm" invites a question
   about the minute that the fit cannot possibly support. */
const dayDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 10)
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const shortDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 16).replace("T", " ")
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) + " " +
      d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
};

function renderSites() {
  const host = $("sitelist");
  if (!UI.sites.length) {
    host.innerHTML = '<div class="empty"><b>No spots yet.</b><br>' +
      "Photograph a crack on the CAPTURE tab. The first photo of a place becomes its baseline; " +
      "the second one, taken from roughly the same position, turns it into a growth rate.</div>";
    return;
  }
  host.innerHTML = UI.sites.map((site) => {
    const g = site.growth;
    const base = g.baseline, last = g.latest;
    const position = (site.lat != null)
      ? site.lat.toFixed(6) + ", " + site.lon.toFixed(6)
      : "no position recorded";
    return '<div class="sitecard">' +
      '<div class="thumbrow">' +
        thumb(base && base.photo_sha, "baseline " + shortDate(base && base.at),
              base ? base.length_mm + " mm" : "—") +
        (site.observations > 1
          ? thumb(last && last.photo_sha, "latest " + shortDate(last && last.at),
                  last ? last.length_mm + " mm" : "—")
          : "") +
      "</div>" +
      "<div>" +
        '<div class="idtag">' + esc(site.id) + "</div>" +
        '<div class="nm">' + esc(site.name) + "</div>" +
        '<div class="meta">' + esc(position) +
          " &nbsp;·&nbsp; " + site.observations + " photo" + (site.observations === 1 ? "" : "s") +
          " &nbsp;·&nbsp; last seen " + esc(shortDate(site.last_seen)) + "<br>" +
          esc(g.headline) + "</div>" +
      "</div>" +
      '<div class="act">' + verdictPill(g.verdict) +
        '<button class="btn ghost" data-open="' + esc(site.id) + '">GROWTH</button>' +
        '<button class="btn ghost" data-drop="' + esc(site.id) + '">DELETE</button>' +
      "</div></div>";
  }).join("");

  host.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    UI.siteId = b.dataset.open;
    renderGrowth();
    switchTab(document.querySelector('.tab[data-p="p3"]'));
  }));
  host.querySelectorAll("[data-drop]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this spot and all of its readings?")) return;
    try { await del("/sites/" + b.dataset.drop); await refreshAll(); renderGrowth(); }
    catch (e) { toast(e.message); }
  }));
}

/* ==================== GROWTH TAB ==================== */
function currentSite() {
  return UI.sites.find((s) => s.id === UI.siteId) || UI.sites[0] || null;
}

/* The traffic light from the deck's deterioration ladder.

   A ward engineer does not read a growth rate; they read whether to send a
   crew this week. So the verdict is stated once, in colour, above everything
   else: red for seal it, amber for it is coming, green for it is holding.

   The wording under each is what the app can honestly support — a date it
   fitted, or the reason there is no date yet. The colour never says more
   than the readings do: a spot with one photograph is grey, not green,
   because "not measured twice" is not the same as "fine". */
function sealSignal(report) {
  const host = $("signal");
  if (!host) return;
  const g = report || {};
  const days = g.days_remaining;
  const verdict = g.verdict;

  let tone, title, line;
  if (verdict === "SEAL NOW") {
    tone = "red"; title = "SEAL IT";
    line = "Past the " + (g.threshold_mm || UI.threshold) + " mm threshold. This is a "
         + "sealing job now, before it becomes a pothole.";
  } else if (verdict === "SEAL SOON") {
    tone = "red"; title = "SEAL IT";
    line = "Crosses " + (g.threshold_mm || UI.threshold) + " mm in about "
         + Math.max(0, Math.round(days)) + " days. Put it on this fortnight\u2019s list.";
  } else if (verdict === "MONITOR") {
    tone = "amber"; title = "WATCH IT";
    line = "About " + Math.max(0, Math.round(days)) + " days of margin. Keep photographing "
         + "it; it is not a crew job yet.";
  } else if (verdict === "WATCH") {
    tone = "amber"; title = "WATCH IT";
    line = "Growing, but slowly \u2014 " + Math.max(0, Math.round(days)) + " days before it "
         + "crosses the line.";
  } else if (verdict === "STABLE") {
    tone = "green"; title = "HOLDING";
    line = "Not growing across " + g.readings + " photographs. Nothing to seal here.";
  } else {
    tone = "grey";
    title = verdict === "NO SCALE" ? "NO MEASUREMENT" : "NOT MEASURED TWICE";
    line = g.readings > 1
      ? "Photographs on one day only. A rate needs two different days."
      : "One photograph is a defect, not a trend. Come back tomorrow and it gets a rate.";
  }

  host.innerHTML =
    '<div class="signal ' + tone + '"><div class="lamp"></div>' +
    '<div><div class="t">' + esc(title) + "</div>" +
    '<div class="s">' + esc(line) + "</div></div>" +
    (g.predicted_cross_date
      ? '<div class="by"><span>SEAL BY</span><b>' + esc(dayDate(g.predicted_cross_date)) +
        "</b></div>"
      : "") +
    "</div>";
}

function renderGrowth() {
  const picker = $("sitepick");
  picker.innerHTML = UI.sites.map((s) =>
    '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>").join("");
  const site = currentSite();
  if (site) { UI.siteId = site.id; picker.value = site.id; }

  const baseline = $("baseline");
  const verdict = $("verdict");
  const stats = $("stats");
  const strip = $("passstrip");
  const table = $("rtab");

  if (!site) {
    baseline.innerHTML = '<div class="empty"><b>Nothing to compare yet.</b><br>' +
      "The baseline is the first photograph of a spot. Take one on the CAPTURE tab.</div>";
    verdict.innerHTML = '<div class="ph">No spot selected.</div>';
    stats.innerHTML = ""; strip.innerHTML = ""; table.innerHTML = "";
    $("signal").innerHTML = "";
    drawChart(null);
    return;
  }

  const g = site.growth;
  const base = g.baseline, last = g.latest;
  sealSignal(g);

  if (!base) {
    baseline.innerHTML = '<div class="empty">No readings on this spot yet.</div>';
  } else if (site.observations < 2) {
    baseline.innerHTML =
      '<div class="compare"><div><div class="lab">BASELINE · ' + esc(shortDate(base.at)) + "</div>" +
      (base.photo_sha ? '<img src="/photo/' + esc(base.photo_sha) + '" alt="baseline photo">' : "") +
      '<div class="val">' + base.length_mm + " mm</div></div>" +
      '<div class="delta"><div class="n">—</div><div class="u">NO SECOND PASS</div></div>' +
      '<div><div class="empty" style="height:100%;display:flex;align-items:center;' +
      'justify-content:center">Photograph this spot again on another day.<br>' +
      "That is when it stops being a defect and starts being a countdown.</div></div></div>";
  } else {
    const delta = (last.length_mm - base.length_mm);
    baseline.innerHTML =
      '<div class="compare">' +
        '<div><div class="lab">BASELINE · ' + esc(shortDate(base.at)) + "</div>" +
        (base.photo_sha ? '<img src="/photo/' + esc(base.photo_sha) + '" alt="baseline photo">' : "") +
        '<div class="val">' + base.length_mm + " mm</div></div>" +
        '<div class="delta"><div class="n">' + (delta >= 0 ? "+" : "") + delta.toFixed(0) +
        '</div><div class="u">MM GROWTH</div></div>' +
        '<div><div class="lab">LATEST · ' + esc(shortDate(last.at)) + "</div>" +
        (last.photo_sha ? '<img src="/photo/' + esc(last.photo_sha) + '" alt="latest photo">' : "") +
        '<div class="val">' + last.length_mm + " mm</div></div>" +
      "</div>";
  }

  if (g.verdict === "SEAL NOW") {
    verdict.innerHTML = '<div class="alert"><div class="t">SEAL NOW</div>' +
      '<div class="s">' + esc(g.headline) + "</div></div>" +
      '<p class="tiny" style="margin-top:12px">' + esc(g.detail) + "</p>";
  } else {
    verdict.innerHTML = '<div class="calm"><div class="t">' + esc(g.headline) + "</div>" +
      '<div class="mut" style="margin-top:8px">' + esc(g.detail) + "</div></div>";
  }

  const signed = (v, unit) => v == null ? "—" : (v > 0 ? "+" : "") + v + " " + unit;
  const fields = [
    ["GROWTH", signed(g.total_growth_mm, "mm")],
    ["PER WEEK", signed(g.mm_per_week, "mm")],
    ["LEAD TIME", g.lead_time_days == null ? "—" : g.lead_time_days + " days"],
    ["DAYS LEFT", g.days_remaining == null ? "—" : Math.max(0, g.days_remaining) + " days"],
    ["FIT R²", g.fit_r2 == null ? "—" : g.fit_r2],
    ["PASSES", g.readings],
  ];
  stats.innerHTML = fields.map((f) => "<div>" + f[0] + "<b>" + esc(f[1]) + "</b></div>").join("");

  strip.innerHTML = '<div class="thumbrow">' + g.series.map((p, i) =>
    thumb(p.photo_sha, "pass " + (i + 1) + " · " + shortDate(p.at), p.length_mm + " mm")).join("") +
    "</div>";

  table.innerHTML = !g.series.length ? "" :
    "<thead><tr><th>#</th><th>WHEN</th><th>DAY</th><th>LENGTH</th><th></th></tr></thead><tbody>" +
    g.series.map((p, i) =>
      "<tr><td class=tiny>" + (i + 1) + "</td><td class=tiny>" + esc(shortDate(p.at)) + "</td>" +
      "<td class=tiny>+" + p.day.toFixed(1) + "</td>" +
      "<td><b" + (p.over_threshold ? ' class="up"' : "") + ">" + p.length_mm + " mm</b></td>" +
      '<td><span class="tiny" style="cursor:pointer;color:var(--faint)" data-del="' +
      p.observation_id + '">remove</span></td></tr>').join("") + "</tbody>";

  table.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("Remove this reading?")) return;
    try { await del("/observations/" + el.dataset.del); await refreshAll(); renderGrowth(); }
    catch (e) { toast(e.message); }
  }));

  drawChart(g);
}

/* ==================== CHART ==================== */
let chartToken = 0;

function drawChart(report) {
  const canvas = $("chart");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const box = canvas.parentElement.getBoundingClientRect();
  canvas.width = box.width * dpr;
  canvas.height = box.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const width = box.width, height = box.height;
  const padL = 52, padR = 18, padT = 18, padB = 40;
  ctx.clearRect(0, 0, width, height);

  const series = report && report.series ? report.series : [];
  const threshold = (report && report.threshold_mm) || UI.threshold;
  const maxValue = Math.max(threshold, ...(series.length ? series.map((p) => p.length_mm) : [100])) * 1.16;
  const maxDay = Math.max(1, ...series.map((p) => p.day));

  const xOf = (day) => padL + (series.length < 2 ? 0.5 : day / maxDay) * (width - padL - padR);
  const yOf = (value) => height - padB - (value / maxValue) * (height - padT - padB);

  function grid() {
    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace,monospace";
    for (let i = 0; i <= 4; i++) {
      const value = maxValue * i / 4, y = yOf(value);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
      ctx.fillStyle = "rgba(167,152,128,0.75)";
      ctx.fillText(value.toFixed(0), 8, y + 3);
    }
    ctx.strokeStyle = "rgba(220,90,70,0.75)";
    ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padL, yOf(threshold)); ctx.lineTo(width - padR, yOf(threshold));
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(220,90,70,0.95)";
    ctx.fillText("SEAL THRESHOLD " + threshold.toFixed(0) + " mm", padL + 6, yOf(threshold) - 7);
  }

  grid();
  if (series.length < 2) {
    ctx.fillStyle = "rgba(167,152,128,0.6)";
    ctx.font = "12px system-ui";
    ctx.fillText(series.length ? "One reading. A rate needs two, on different days."
                               : "No readings on this spot yet.", padL + 8, height / 2);
    return;
  }

  const points = series.map((p) => ({ x: xOf(p.day), y: yOf(p.length_mm), v: p.length_mm }));
  const token = ++chartToken;
  let progress = 0;

  // The fitted line is what the verdict is actually based on, so draw it.
  const slope = report.mm_per_day, first = series[0].length_mm;

  (function step() {
    if (token !== chartToken) return;
    progress = Math.min(1, progress + 0.045);
    const ease = 1 - Math.pow(1 - progress, 3);
    ctx.clearRect(0, 0, width, height);
    grid();

    if (slope) {
      ctx.strokeStyle = "rgba(127,168,201,0.45)";
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(first));
      ctx.lineTo(xOf(maxDay * ease), yOf(first + slope * maxDay * ease));
      ctx.stroke(); ctx.setLineDash([]);
    }

    const cut = Math.max(1, Math.ceil(points.length * ease));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < cut; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = "#E0A54B"; ctx.lineWidth = 2.5;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.stroke();

    ctx.lineTo(points[cut - 1].x, height - padB);
    ctx.lineTo(points[0].x, height - padB);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, padT, 0, height - padB);
    gradient.addColorStop(0, "rgba(224,165,75,0.22)");
    gradient.addColorStop(1, "rgba(224,165,75,0)");
    ctx.fillStyle = gradient; ctx.fill();

    /* Eighteen daily passes will not fit eighteen labels across a card.
       Work out how many each label needs — its own width plus a gap — and
       print every nth, always keeping the first and the last so the span
       of the record is still readable. Overlapping text is worse than
       fewer labels: it stops being a chart and becomes a smear. */
    ctx.font = "9px system-ui";
    const labelWidth = ctx.measureText("day 18").width + 14;
    const plotWidth = width - padL - padR;
    const everyN = Math.max(1, Math.ceil(points.length * labelWidth / Math.max(1, plotWidth)));
    const valueEveryN = points.length > 12 ? 2 : 1;

    for (let i = 0; i < cut; i++) {
      const point = points[i];
      const last = i === points.length - 1;
      ctx.fillStyle = series[i].over_threshold ? "#DC5A46" : "#E0A54B";
      ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, 6.283); ctx.fill();
      ctx.fillStyle = "#0A0907";
      ctx.beginPath(); ctx.arc(point.x, point.y, 2, 0, 6.283); ctx.fill();
      ctx.textAlign = "center";
      if (i === 0 || last || i % valueEveryN === 0) {
        ctx.fillStyle = "rgba(242,237,228,0.92)";
        ctx.font = "bold 11px ui-monospace,monospace";
        ctx.fillText(point.v.toFixed(0), point.x, point.y - 13);
      }
      // The last label is always drawn, so suppress any strided one close
      // enough to collide with it — "day 16day 17" is not a label.
      const nearLast = !last && (points.length - 1 - i) < everyN;
      if (i === 0 || last || (i % everyN === 0 && !nearLast)) {
        ctx.fillStyle = "rgba(167,152,128,0.7)";
        ctx.font = "9px system-ui";
        ctx.fillText("day " + series[i].day.toFixed(0), point.x, height - padB + 16);
      }
      ctx.textAlign = "left";
    }
    if (progress < 1) requestAnimationFrame(step);
  })();
}

/* ==================== SEAL LIST ==================== */
function bandPill(band) {
  const cls = { "URGENT": "bad", "HIGH": "warn", "MEDIUM": "", "LOW": "",
                "STABLE": "ok", "NO RATE YET": "" }[band] || "";
  return '<span class="pill ' + cls + '">' + esc(band) + "</span>";
}

async function renderSchedule() {
  let data;
  try {
    data = await api("/schedule");
  } catch (error) {
    $("sched").innerHTML = '<div class="note bad">' + esc(error.message) + "</div>";
    $("leadbox").innerHTML = "";
    return;
  }

  const lead = data.lead_time;
  $("leadbox").innerHTML = lead.sites_with_lead_time
    ? '<div class="leadrow">' +
      "<div><b>" + lead.mean_days + '</b><span>MEAN LEAD TIME, DAYS</span></div>' +
      "<div><b>" + lead.median_days + '</b><span>MEDIAN, DAYS</span></div>' +
      "<div><b>" + lead.min_days + '</b><span>SHORTEST WARNING</span></div>' +
      "<div><b>" + lead.sites_with_lead_time + '</b><span>SPOTS WITH A DATED CROSSING</span></div>' +
      "</div>"
    : '<div class="empty">No lead time yet. It needs one spot photographed on two ' +
      "different days, with the crack growing between them.</div>";

  const risk = data.risk || {};
  $("formulabox").innerHTML =
    '<div class="eq"><span class="term measured">growth rate<em>mm / day, measured</em></span>' +
    '<span class="op">×</span>' +
    '<span class="term">rainfall forecast<em>next ' + esc(risk.window_days || 14) + ' days</em></span>' +
    '<span class="op">×</span>' +
    '<span class="term">traffic<em>commercial vehicles / day</em></span>' +
    '<span class="op">=</span>' +
    '<span class="term out">priority<em>0 – 100</em></span></div>' +
    (risk.scored
      ? '<div class="leadrow" style="margin-top:16px">' +
        "<div><b>" + risk.urgent + '</b><span>URGENT</span></div>' +
        "<div><b>" + risk.high + '</b><span>HIGH</span></div>' +
        "<div><b>" + (risk.rain_window_mm == null ? "—" : risk.rain_window_mm) +
          '</b><span>MM OF RAIN EXPECTED</span></div>' +
        "<div><b>" + risk.no_rate_yet + '</b><span>NOT SCORED — ONE PHOTO ONLY</span></div>' +
        "</div>"
      : "");

  const rows = data.rows;
  const num = (v, unit, digits) => v == null ? "—" : (+v).toFixed(digits == null ? 2 : digits) +
    (unit ? " " + unit : "");

  $("sched").innerHTML = !rows.length
    ? '<div class="empty"><b>The list is empty, and that is correct.</b><br>' +
      "Nothing here is filled in from a demo file. Photograph a crack and it appears.</div>"
    : '<div class="tscroll"><table><thead><tr><th>#</th><th>SPOT</th><th>LATEST</th>' +
      "<th>GROWTH</th><th>× RAIN</th><th>× TRAFFIC</th><th>= EFFECTIVE</th>" +
      "<th>PRIORITY</th><th>SEAL BY</th><th>ACTION</th></tr></thead><tbody>" +
      rows.map((r) =>
        "<tr><td class=tiny>" + (r.rank == null ? "—" : r.rank) + "</td>" +
        "<td>" + esc(r.name) + '<div class="tiny">' + esc(r.site_id) + " · " +
          r.observations + " photos · " + esc(r.road_class) + "</div></td>" +
        "<td>" + (r.latest_mm == null ? "—" : r.latest_mm + " mm") + "</td>" +
        "<td" + (r.mm_per_day > 0 ? ' class="up"' : "") + ">" +
          num(r.mm_per_day, "mm/d", 2) +
          '<div class="tiny">' + (r.fit_r2 == null ? "no fit" : "R² " + r.fit_r2) + "</div></td>" +
        "<td>" + num(r.rain_factor, "", 2) +
          '<div class="tiny">' + (r.rain_mm == null ? "no position" : r.rain_mm + " mm · " +
            esc(r.rain_basis)) + "</div></td>" +
        "<td>" + num(r.traffic_factor, "", 2) + "</td>" +
        "<td>" + num(r.effective_mm_per_day, "mm/d", 2) + "</td>" +
        "<td>" + (r.priority == null ? "—" : "<b>" + r.priority + "</b>") + "<br>" +
          bandPill(r.band) + "</td>" +
        "<td>" + (r.monsoon_days_remaining == null ? "—"
                  : Math.max(0, Math.round(r.monsoon_days_remaining)) + " d") +
          '<div class="tiny">' + (r.days_bought_by_rain ? "rain costs " +
            r.days_bought_by_rain + " d" : "") + "</div></td>" +
        "<td>" + verdictPill(r.verdict) + "</td></tr>").join("") +
      "</tbody></table></div>" +
      '<p class="tiny" style="margin-top:12px">SEAL BY is the crossing date at the effective ' +
      "rate — growth with the rain in it. The dry-fit date is on the GROWTH tab; where the " +
      "two differ, the difference is what the monsoon costs.</p>";
}

/* ==================== REPORT ==================== */
function reportRow(label, value, note) {
  return "<div><span>" + esc(label) + "</span><b>" + value + "</b>" +
         (note ? '<em class="tiny">' + esc(note) + "</em>" : "") + "</div>";
}

async function renderReport() {
  const picker = $("reportpick");
  picker.innerHTML = UI.sites.map((s) =>
    '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>").join("");
  const host = $("report");

  if (!UI.sites.length) {
    host.innerHTML = '<div class="empty"><b>No spot to report on yet.</b><br>' +
      "Photograph a crack on the CAPTURE tab. A report needs at least two passes to say " +
      "anything about growth, and the deck's own answer is three weeks of them.</div>";
    return;
  }
  if (!UI.reportId || !UI.sites.some((s) => s.id === UI.reportId)) {
    UI.reportId = (currentSite() || UI.sites[0]).id;
  }
  picker.value = UI.reportId;

  let data;
  try {
    data = await api("/report/" + encodeURIComponent(UI.reportId));
  } catch (error) {
    host.innerHTML = '<div class="note bad">' + esc(error.message) + "</div>";
    return;
  }

  const site = data.site, g = data.predict, sched = data.schedule, v = data.verify;
  $("cvpd").value = sched.traffic.basis === "counted"
    ? sched.traffic.commercial_vehicles_per_day : "";
  if ($("roadclass").options.length) $("roadclass").value = site.road_class;

  const days = (value) => value == null ? "—" : Math.round(value) + " days";
  const mm = (value, digits) => value == null ? "—" : (+value).toFixed(digits == null ? 1 : digits) + " mm";

  /* Five boxes, in the order the deck tells it. Each says one thing.
     Anything a judge would only ask a harder question about — the fit
     constants, the module names, the per-tag EXIF list — is gone. What
     survives is what a ward engineer would act on. */

  const detect =
    '<div class="card"><h3>1 · DETECT</h3>' +
    '<div class="rrows">' +
      reportRow("Photographs of this crack", data.detect.passes,
                "every one taken, measured and stored on this machine") +
      reportRow("First measured", mm(g.baseline ? g.baseline.length_mm : null),
                g.baseline ? shortDate(g.baseline.at) : "none yet") +
      reportRow("Latest", mm(g.latest ? g.latest.length_mm : null),
                g.latest ? shortDate(g.latest.at) : "none yet") +
      reportRow("Growth so far", mm(g.total_growth_mm), "the number the whole app rests on") +
    "</div></div>";

  const track =
    '<div class="card"><h3>2 · TRACK — THE SAME METRE OF ROAD</h3>' +
    '<div class="gps"><div class="coord">' + esc(site.position_text || "no position") + "</div>" +
    '<dl class="kv">' +
      "<dt>DEG MIN SEC</dt><dd>" + esc(site.position_dms || "—") + "</dd>" +
      "<dt>PASSES WITH A FIX</dt><dd>" + data.track.with_position + " of " +
        data.detect.passes + "</dd>" +
      "<dt>MATCHED WITHIN</dt><dd>" + data.track.radius_m + " m, heading within " +
        data.track.heading_tolerance_deg + "°</dd>" +
    "</dl>" +
    (site.map_url ? '<div><a href="' + esc(site.map_url) + '" target="_blank" ' +
      'rel="noopener">open this spot on a map →</a></div>' : "") +
    "</div></div>";

  const predict =
    '<div class="card"><h3>3 · PREDICT</h3>' +
    (g.verdict === "SEAL NOW"
      ? '<div class="alert"><div class="t">SEAL NOW</div><div class="s">' +
        esc(g.headline) + "</div></div>"
      : '<div class="calm"><div class="t">' + esc(g.headline) + "</div></div>") +
    '<div class="rrows" style="margin-top:14px">' +
      reportRow("Growth rate", g.mm_per_day == null ? "—" : g.mm_per_day + " mm/day",
                "measured across " + g.readings + " photographs") +
      reportRow("Crosses " + mm(g.threshold_mm, 0), g.predicted_cross_date
                ? shortDate(g.predicted_cross_date) : "—", "at the measured rate") +
      reportRow("Lead time", days(g.lead_time_days),
                "first sighting to predicted failure") +
    "</div></div>";

  const schedule =
    '<div class="card"><h3>4 · SCHEDULE — GROWTH × RAIN × TRAFFIC</h3>' +
    '<div class="eq"><span class="term measured">' +
      (sched.growth.mm_per_day == null ? "—" : sched.growth.mm_per_day) +
      "<em>mm / day measured</em></span><span class=\"op\">×</span>" +
    '<span class="term">' + sched.rain.factor + "<em>rain, " +
      (sched.rain.expected_mm == null ? "no position" : sched.rain.expected_mm + " mm in " +
       sched.rain.window_days + " days") + "</em></span><span class=\"op\">×</span>" +
    '<span class="term">' + sched.traffic.factor + "<em>" +
      esc(sched.traffic.road_class_label.toLowerCase()) + "</em></span>" +
      "<span class=\"op\">=</span>" +
    '<span class="term out">' + (sched.score == null ? "—" : sched.score) +
      "<em>priority</em></span></div>" +
    '<div class="note ' + (sched.band === "URGENT" ? "bad" : sched.band === "HIGH" ? "warn" : "ok") +
      '" style="margin-top:14px"><b>' + esc(sched.band) + ".</b> " + esc(sched.action) + "</div>" +
    '<div class="rrows" style="margin-top:14px">' +
      reportRow("Seal by, with the rain in it", sched.monsoon_cross_date
                ? shortDate(sched.monsoon_cross_date) : "—",
                sched.days_bought_by_rain
                  ? "the monsoon brings it forward by " + sched.days_bought_by_rain + " days"
                  : "same as the dry-weather date") +
      reportRow("Rain expected", sched.rain.expected_mm == null ? "—"
                : sched.rain.expected_mm + " mm",
                "monthly normal for " + esc(sched.rain.station || "this area") +
                " — a normal, not a forecast") +
    "</div></div>";

  const verify =
    '<div class="card"><h3>5 · VERIFY</h3>' +
    '<div class="calm"><div class="t">' + esc(v.state) + "</div>" +
    '<div class="mut" style="margin-top:8px">' + esc(v.note) + "</div></div></div>";

  /* Eighteen rows of detail is a gift to a hostile question and a burden in
     a five-minute demo. It stays available, folded, for anyone who asks. */
  const passes =
    '<div class="card"><details><summary><b>Every pass, day by day</b> — ' +
    data.passes.length + " photographs</summary><div class=\"tscroll\" style=\"margin-top:14px\">" +
    "<table><thead><tr><th>DAY</th><th>WHEN</th><th>LENGTH</th><th>GROWTH</th>" +
    "<th>POSITION</th><th>WHY THE SAME SPOT</th></tr></thead><tbody>" +
    data.passes.map((row) =>
      "<tr><td><b>" + (row.day == null ? "—" : row.day) + "</b></td>" +
      "<td class=tiny>" + esc(shortDate(row.captured_at)) + "</td>" +
      "<td>" + (row.length_mm == null ? row.arc_px + " px" : row.length_mm + " mm") + "</td>" +
      "<td" + (row.growth_since_baseline_mm > 0 ? ' class="up"' : "") + ">" +
        (row.growth_since_baseline_mm == null ? "—"
         : (row.growth_since_baseline_mm > 0 ? "+" : "") + row.growth_since_baseline_mm + " mm") +
      "</td>" +
      "<td class=tiny>" + (row.lat == null ? "none"
        : (+row.lat).toFixed(5) + ", " + (+row.lon).toFixed(5)) + "</td>" +
      "<td class=tiny>" + esc(row.match ? row.match.why : "") + "</td></tr>").join("") +
    "</tbody></table></div></details></div>";

  host.innerHTML =
    '<div class="card" style="margin-bottom:18px"><h3>' + esc(site.id) + " · " +
      esc(site.name) + "</h3>" +
      '<p class="tiny">' + (site.road_name ? esc(site.road_name) + " · " : "") +
      (site.ward ? esc(site.ward) + " · " : "") + esc(site.road_class_label) +
      " · threshold " + mm(site.threshold_mm, 0) + "</p></div>" +
    detect + '<div style="height:18px"></div>' +
    track + '<div style="height:18px"></div>' +
    predict + '<div style="height:18px"></div>' +
    schedule + '<div style="height:18px"></div>' +
    verify + '<div style="height:18px"></div>' +
    passes;
}

/* ==================== DETECTION QUALITY ==================== */
async function renderQuality() {
  const host = $("quality");
  let data;
  try {
    data = await api("/metrics/detection");
  } catch (error) {
    host.innerHTML = '<div class="note bad">' + esc(error.message) + "</div>";
    return;
  }

  /* When there is no score, say the one thing that matters in a sentence and
     stop. The old version listed the four RDD2022 classes with "not evaluated"
     against each — a table of blanks that only ever invited the question
     "so what IS your mAP?". This build measures crack growth. That is the
     honest headline, and it is a strength, not an apology. */
  if (!data.evaluated) {
    host.innerHTML =
      '<div class="card"><h3>WHAT THIS BUILD MEASURES</h3>' +
      '<p class="lede" style="margin:0">This prototype measures how fast a crack is ' +
      "<b>growing</b>. It does not classify damage types, so there is no mAP to " +
      "report — and a number here that we had not actually measured would be worse " +
      "than a blank.</p>" +
      '<div class="note ok" style="margin-top:18px"><b>What we measure instead.</b> ' +
      "Growth in millimetres per day, the quality of the fit behind it, and the " +
      "lead time in days between a crack being seen and its predicted failure. " +
      "Those are on the GROWTH and SEAL LIST tabs, computed from photographs " +
      "taken on this machine.</div>" +
      '<p class="tiny" style="margin-top:16px">When a damage classifier is trained, ' +
      "its score appears here per class, on a named test split, with the sample size " +
      "beside it — the page refuses to print a headline figure without them.</p></div>";
    return;
  }


  const s = data.sample;
  host.innerHTML =
    '<div class="card"><h3>' + esc(data.split) + "</h3>" +
    '<div class="statgrid">' +
      "<div><b>" + (data.map == null ? "—" : data.map.toFixed(3)) + "</b><span>mAP @ IoU " +
        data.iou_threshold.toFixed(2) + "</span></div>" +
      "<div><b>" + (data.map_iou_sweep == null ? "—" : data.map_iou_sweep.toFixed(3)) +
        "</b><span>mAP @ [.50:.95]</span></div>" +
      "<div><b>" + s.images_with_ground_truth.toLocaleString("en-IN") +
        "</b><span>IMAGES IN THE SPLIT</span></div>" +
      "<div><b>" + s.ground_truth_instances.toLocaleString("en-IN") +
        "</b><span>GROUND-TRUTH INSTANCES</span></div>" +
      "<div><b>" + s.predictions.toLocaleString("en-IN") + "</b><span>PREDICTIONS SCORED</span></div>" +
    "</div>" +
    '<p class="tiny" style="margin-top:14px">Model: ' + esc(data.model) +
      " &nbsp;·&nbsp; recorded " + esc(shortDate(data.recorded_at)) +
      (data.notes ? " &nbsp;·&nbsp; " + esc(data.notes) : "") + "</p></div>" +

    '<div class="card" style="margin-top:18px"><h3>PER DAMAGE CLASS</h3><div class="tscroll">' +
    "<table><thead><tr><th>CLASS</th><th>NAME</th><th>AP@" + data.iou_threshold.toFixed(2) +
    "</th><th>AP@[.5:.95]</th><th>GT INSTANCES</th><th>IMAGES</th><th>PREDICTIONS</th>" +
    "<th>BEST F1</th></tr></thead><tbody>" +
    data.per_class.map((c) =>
      "<tr><td class=mono>" + esc(c.class) + "</td><td>" + esc(c.name) + "</td>" +
      "<td><b>" + (c.ap == null ? "—" : c.ap.toFixed(3)) + "</b></td>" +
      "<td>" + (c.ap_iou_sweep == null ? "—" : c.ap_iou_sweep.toFixed(3)) + "</td>" +
      "<td>" + c.gt_instances + "</td><td>" + c.gt_images + "</td>" +
      "<td>" + c.predictions + "</td><td>" + c.best_f1.toFixed(3) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<p class="tiny" style="margin-top:14px">Quote it whole: mAP@' +
      data.iou_threshold.toFixed(2) + " = " + (data.map == null ? "—" : data.map.toFixed(3)) +
      " on " + esc(data.split) + ", " + s.images_with_ground_truth + " images, " +
      s.ground_truth_instances + " instances. A class with few instances has a noisy AP — " +
      "the instance count is in the table for exactly that reason.</p></div>";
}

/* ==================== TRAINING TAB ==================== */
let calImage = null, calIndex = 0, calThreshold = 110, calResult = null;

function runCalibration(img, photo, keepIndex) {
  calImage = img;
  if (!keepIndex) calIndex = 0;
  const result = analyseImage(img, calThreshold);
  calResult = result;
  if (result.err) { stageError("st1", result.err); $("out1").innerHTML = ""; return; }

  showOnStage("st1", result.paint(calIndex));
  const candidate = result.candidates[Math.min(calIndex, result.candidates.length - 1)];
  let html = '<div class="note ok">Reference line measured at <b>' +
    candidate.span.toFixed(0) + " pixels</b> across. Calibration uses the straight distance, " +
    "exactly as a ruler does.</div>";
  if (candidate.straightness < 0.93) {
    html += '<div class="note warn"><b>That line looks curved.</b> Use a straight one — ' +
      "a curved reference biases everything measured afterwards.</div>";
  }
  if (result.candidates.length > 1) {
    html += '<button class="btn ghost" id="cyccal">Wrong shape? Next candidate (' +
      (calIndex + 1) + " of " + result.candidates.length + ")</button>";
  }
  $("out1").innerHTML = html;
  const cycle = $("cyccal");
  if (cycle) cycle.addEventListener("click", () => {
    calIndex = (calIndex + 1) % calResult.candidates.length;
    runCalibration(calImage, null, true);
  });
}

async function renderTrials() {
  let data;
  try {
    data = await api("/trials");
  } catch (error) {
    $("perr").innerHTML = '<div class="note bad">' + esc(error.message) + "</div>";
    return;
  }
  $("ptab").innerHTML = !data.count ? "" :
    "<thead><tr><th>I DREW</th><th>SYSTEM SAID</th><th>ERROR</th></tr></thead><tbody>" +
    data.trials.map((t) => "<tr><td>" + t.drew_mm + " mm</td><td>" + t.said_mm +
      " mm</td><td><b>" + t.error_mm.toFixed(1) + " mm</b></td></tr>").join("") + "</tbody>";
  $("perr").innerHTML = !data.count ? "" :
    '<div class="readout" style="background:linear-gradient(135deg,rgba(95,168,107,.12),' +
    'rgba(95,168,107,.03));border-color:rgba(95,168,107,.3)">' +
    '<div class="l">MEAN ERROR ACROSS ' + data.count + " TRIALS</div>" +
    '<div class="v" style="color:var(--green)">' + data.mean_error_mm +
    '<span class="u">mm</span></div></div>' +
    '<div class="tiny" style="margin-top:10px">Worst single trial: ' + data.worst_error_mm +
    " mm. Say both numbers on stage; do not round either one in your favour.</div>";
}

/* ==================== NAVIGATION ==================== */
const tabs = [...document.querySelectorAll(".tab")];
const ink = $("ink");

function moveInk(tab) {
  if (!tab) return;
  ink.style.left = tab.offsetLeft + "px";
  ink.style.width = tab.offsetWidth + "px";
}

function switchTab(target) {
  if (!target) return;
  tabs.forEach((t) => { t.classList.remove("on"); t.setAttribute("aria-current", "false"); });
  target.classList.add("on");
  target.setAttribute("aria-current", "page");
  moveInk(target);

  const pageId = target.dataset.p;
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("on"));
  const page = $(pageId);
  if (!page) return;
  page.classList.add("on");

  if (pageId !== "p1" && pageId !== "p6") stopCamera();
  if (window.RoadHero) window.RoadHero.sync();
  if (pageId === "p1") askDevicePosition();
  if (pageId === "p2") renderSites();
  if (pageId === "p3") renderGrowth();
  if (pageId === "p4") renderSchedule();
  if (pageId === "p5") renderQuality();
  if (pageId === "p6") renderTrials();
  if (pageId === "p7") renderReport();
  $("apihint").textContent = { p2: "GET /api/sites", p3: "GET /api/sites/<id>",
    p4: "GET /api/schedule", p5: "GET /api/metrics/detection",
    p7: "GET /api/report/<id>", p1: "POST /api/observations" }[pageId] || "GET /api/state";
}

tabs.forEach((tab) => tab.addEventListener("click", () => switchTab(tab)));
window.addEventListener("resize", () => {
  moveInk(document.querySelector(".tab.on"));
  if ($("p3").classList.contains("on")) renderGrowth();
});

function setTrainingMode(on) {
  document.body.classList.toggle("training", on);
  try { localStorage.setItem("raahi.training", on ? "1" : "0"); } catch (e) { /* private mode */ }
  moveInk(document.querySelector(".tab.on"));
}

/* ==================== STATE ==================== */
async function refreshAll() {
  try {
    const [state, sites] = await Promise.all([api("/state"), api("/sites")]);
    UI.sites = sites.sites;
    UI.threshold = state.threshold_mm;
    UI.calibration = state.calibration;
    $("th").value = state.threshold_mm;
    $("thv").textContent = state.threshold_mm;
    $("th").style.setProperty("--p", ((state.threshold_mm - 20) / 580 * 100) + "%");

    $("cal").innerHTML = '<span class="dot"></span>' + state.sites + " SPOT" +
      (state.sites === 1 ? "" : "S") + " · " + state.observations + " PHOTO" +
      (state.observations === 1 ? "" : "S");

    const lead = state.lead_time;
    $("ovstats").innerHTML = [
      [state.sites, "spots on the round"],
      [state.observations, "photographs measured"],
      [lead.mean_days == null ? "—" : lead.mean_days, "mean lead time, days"],
      [state.mean_error_mm == null ? "—" : state.mean_error_mm, "mean error against a ruler, mm"],
      [state.detection_evaluated ? "yes" : "not yet", "detector scored on a named split"],
      [state.calibration ? state.calibration.mm_per_px.toFixed(4) : "lens",
       state.calibration ? "mm per pixel, calibrated" : "scale taken from the lens, not calibrated"],
    ].map((r) => "<div><b>" + esc(r[0]) + "</b><span>" + esc(r[1]) + "</span></div>").join("");

    renderSiteChooser();
    if (!UI.roadClasses.length) {
      try {
        const table = await api("/traffic");
        UI.roadClasses = table.classes;
        $("roadclass").innerHTML = table.classes.map((c) =>
          '<option value="' + esc(c.key) + '">' + esc(c.label) + " · " + c.cvpd +
          " cv/day</option>").join("");
      } catch (error) { /* the class list is a convenience, not a requirement */ }
    }
    if ($("p2").classList.contains("on")) renderSites();
    if ($("p7").classList.contains("on")) renderReport();
  } catch (error) {
    $("cal").innerHTML = '<span class="dot" style="background:var(--red)"></span>BACKEND OFFLINE';
    toast("Cannot reach the backend. Is python3 server.py still running?");
  }
}

/* ==================== WIRING ==================== */
$("startround").addEventListener("click", () => {
  switchTab(document.querySelector('.tab[data-p="p1"]'));
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// Capture tab
document.querySelectorAll("#src button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("#src button").forEach((b) => {
      b.classList.remove("on"); b.setAttribute("aria-pressed", "false");
    });
    button.classList.add("on");
    button.setAttribute("aria-pressed", "true");
    if (button.dataset.m === "cam") {
      $("pickwrap").style.display = "none";
      askDevicePosition();
      startCamera("camwrap", (img, photo) => runCapture(img, photo));
    } else {
      stopCamera();
      $("pickwrap").style.display = "block";
    }
  });
});
$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", () => {
  const files = [...$("file").files];
  $("file").value = "";                    // so the same folder can be re-chosen
  if (!files.length) return;
  if (files.length === 1) {
    readPhoto(files[0]).then(({ img, photo }) => runCapture(img, photo))
                       .catch((error) => toast(error.message));
    return;
  }
  $("batch").innerHTML = "";
  runBatch(files);
});
$("saveread").addEventListener("click", saveReading);

$("t2").addEventListener("input", () => {
  captureThreshold = +$("t2").value;
  $("t2v").textContent = String(captureThreshold);
  $("t2").style.setProperty("--p", ((captureThreshold - 40) / 170 * 100) + "%");
  if (captureImage) runCapture(captureImage, null, true);
});

// Growth tab
$("sitepick").addEventListener("change", () => { UI.siteId = $("sitepick").value; renderGrowth(); });

let thresholdTimer = null;
$("th").addEventListener("input", () => {
  UI.threshold = +$("th").value;
  $("thv").textContent = String(UI.threshold);
  $("th").style.setProperty("--p", ((UI.threshold - 20) / 580 * 100) + "%");
  clearTimeout(thresholdTimer);
  thresholdTimer = setTimeout(async () => {
    try { await post("/threshold", { threshold_mm: UI.threshold }); await refreshAll(); renderGrowth(); }
    catch (e) { toast(e.message); }
  }, 400);
});

// Training tab
document.querySelectorAll("#src1 button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("#src1 button").forEach((b) => {
      b.classList.remove("on"); b.setAttribute("aria-pressed", "false");
    });
    button.classList.add("on");
    button.setAttribute("aria-pressed", "true");
    if (button.dataset.m === "cam") {
      $("pickwrap1").style.display = "none";
      startCamera("camwrap1", (img) => runCalibration(img));
    } else {
      stopCamera();
      $("pickwrap1").style.display = "block";
    }
  });
});
$("pick1").addEventListener("click", () => $("file1").click());
onFileChosen($("file1"), (img) => runCalibration(img));
$("t1").addEventListener("input", () => {
  calThreshold = +$("t1").value;
  $("t1v").textContent = String(calThreshold);
  $("t1").style.setProperty("--p", ((calThreshold - 40) / 170 * 100) + "%");
  if (calImage) runCalibration(calImage, null, true);
});

$("docal").addEventListener("click", async () => {
  if (!calImage || !calResult || calResult.err) {
    toast("Photograph your reference line first."); return;
  }
  const candidate = calResult.candidates[Math.min(calIndex, calResult.candidates.length - 1)];
  const trueLength = +$("truemm").value;
  if (!(trueLength > 0)) { toast("Enter the true length in millimetres."); return; }
  try {
    const data = await post("/calibration", {
      scope: "global", ref_mm: trueLength, ref_px: candidate.span,
      image_width: calResult.width, note: "reference line, training tab",
    });
    await refreshAll();
    say("out1", "<b>Calibrated.</b> 1 pixel = " + data.calibration.mm_per_px.toFixed(4) +
        " mm at " + calResult.width + " px wide. Photos of other sizes are rescaled " +
        "automatically. Nobody on the round has to know this number exists.", "ok");
  } catch (error) { toast(error.message); }
});

$("addproof").addEventListener("click", async () => {
  try {
    await post("/trials", { drew_mm: +$("drew").value, said_mm: +$("said").value });
    renderTrials();
  } catch (error) { toast(error.message); }
});

$("runeval").addEventListener("click", async () => {
  const split = $("evsplit").value.trim();
  if (!split) { toast("Name the test split — a score without one is not a result."); return; }
  $("evmsg").innerHTML = '<div class="note warn">Scoring…</div>';
  try {
    await post("/metrics/detection", {
      split: split, model: $("evmodel").value.trim(),
      ground_truth: $("evgt").value.trim(), predictions: $("evpred").value.trim(),
    });
    say("evmsg", "Scored. See the DETECTION QUALITY tab.", "ok");
    await refreshAll();
    renderQuality();
  } catch (error) { say("evmsg", esc(error.message), "bad"); }
});

// Training visibility: a link in the footer, or ?training=1 in the address bar.
// Start over
$("clearall").addEventListener("click", async () => {
  if (!confirm("Clear every spot, reading and photograph?\n\nThis cannot be undone. "
             + "Your calibration and seal threshold are kept.")) return;
  try {
    const out = await del("/records");
    UI.siteId = null; UI.reportId = null;
    await refreshAll();
    renderSites();
    toast(out.observations_removed + " readings cleared. The round starts fresh.", "ok");
  } catch (error) { toast(error.message); }
});

// Report tab
$("reportpick").addEventListener("change", () => {
  UI.reportId = $("reportpick").value;
  renderReport();
});

$("savecontext").addEventListener("click", async () => {
  if (!UI.reportId) { toast("Choose a spot first."); return; }
  const count = parseFloat($("cvpd").value);
  try {
    await post("/sites/" + encodeURIComponent(UI.reportId) + "/context", {
      road_class: $("roadclass").value,
      commercial_vehicles_per_day: isFinite(count) && count >= 0 ? count : null,
    });
    await refreshAll();
    renderReport();
    toast("Road set. The traffic term is recomputed.", "ok");
  } catch (error) { toast(error.message); }
});

$("trainlink").addEventListener("click", () => {
  setTrainingMode(!document.body.classList.contains("training"));
});
$("trainlink").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("trainlink").click(); }
});

/* ==================== BOOT ==================== */
(function start() {
  const params = new URLSearchParams(location.search);
  let training = params.get("training") === "1";
  try { training = training || localStorage.getItem("raahi.training") === "1"; }
  catch (e) { /* private mode */ }
  if (training) setTrainingMode(true);

  moveInk(tabs[0]);
  $("t1").style.setProperty("--p", "41%");
  $("t2").style.setProperty("--p", "41%");
  refreshAll();
})();
