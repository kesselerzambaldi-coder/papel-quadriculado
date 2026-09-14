(() => {
  "use strict";

  const STORAGE_KEY = "quadriculado.v1";
  const MIN_SCALE = 14;
  const MAX_SCALE = 220;
  const MIN_SEGMENT_LEN = 0.12; // in grid units, ignores accidental taps

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const emptyHint = document.getElementById("emptyHint");
  const toolbar = document.getElementById("toolbar");
  const scaleBtn = document.getElementById("scaleBtn");
  const scaleLabel = document.getElementById("scaleLabel");
  const settingsBackdrop = document.getElementById("settingsBackdrop");
  const closeSettingsBtn = document.getElementById("closeSettings");
  const scaleOptions = document.getElementById("scaleOptions");
  const snapOptions = document.getElementById("snapOptions");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const clearBtn = document.getElementById("clearBtn");
  const exportBtn = document.getElementById("exportBtn");
  const toastEl = document.getElementById("toast");

  let dpr = Math.max(1, window.devicePixelRatio || 1);

  // ---------- State ----------

  const state = {
    settings: { squareCm: 10, snapDivisions: 1 },
    elements: [], // {type:'wall'|'dim', x0,y0,x1,y1}
    tool: "draw",
  };

  const view = { scale: 44, offsetX: 0, offsetY: 0 };

  const history = { stack: [], index: -1 };

  let toastTimer = null;

  // ---------- Persistence ----------

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ settings: state.settings, elements: state.elements })
      );
    } catch (e) {
      /* storage unavailable — app still works this session */
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.settings) Object.assign(state.settings, data.settings);
      if (Array.isArray(data.elements)) state.elements = data.elements;
    } catch (e) {
      /* ignore corrupt storage */
    }
  }

  // ---------- History (undo/redo) ----------

  function pushHistory() {
    const snapshot = JSON.stringify(state.elements);
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snapshot);
    if (history.stack.length > 60) history.stack.shift();
    history.index = history.stack.length - 1;
    updateHistoryButtons();
    save();
  }

  function undo() {
    if (history.index <= 0) return;
    history.index -= 1;
    state.elements = JSON.parse(history.stack[history.index]);
    updateHistoryButtons();
    save();
    redraw();
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index += 1;
    state.elements = JSON.parse(history.stack[history.index]);
    updateHistoryButtons();
    save();
    redraw();
  }

  function updateHistoryButtons() {
    undoBtn.style.opacity = history.index <= 0 ? "0.35" : "1";
    redoBtn.style.opacity = history.index >= history.stack.length - 1 ? "0.35" : "1";
  }

  // ---------- Coordinate transforms ----------

  function screenToWorld(sx, sy) {
    return { x: (sx - view.offsetX) / view.scale, y: (sy - view.offsetY) / view.scale };
  }

  function worldToScreen(x, y) {
    return { x: x * view.scale + view.offsetX, y: y * view.scale + view.offsetY };
  }

  function snap(v) {
    const d = state.settings.snapDivisions;
    return Math.round(v * d) / d;
  }

  function snapPoint(p) {
    return { x: snap(p.x), y: snap(p.y) };
  }

  // ---------- Canvas sizing ----------

  function resizeCanvas() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function viewportSize() {
    const rect = canvas.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  }

  function centerView() {
    const { w, h } = viewportSize();
    view.offsetX = w / 2;
    view.offsetY = h / 2;
  }

  function fitToElements() {
    if (state.elements.length === 0) {
      view.scale = 44;
      centerView();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of state.elements) {
      minX = Math.min(minX, el.x0, el.x1);
      maxX = Math.max(maxX, el.x0, el.x1);
      minY = Math.min(minY, el.y0, el.y1);
      maxY = Math.max(maxY, el.y0, el.y1);
    }
    const pad = 2;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const { w, h } = viewportSize();
    const spanX = Math.max(0.001, maxX - minX);
    const spanY = Math.max(0.001, maxY - minY);
    const scale = Math.min(w / spanX, h / spanY, MAX_SCALE);
    view.scale = Math.max(MIN_SCALE, scale);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    view.offsetX = w / 2 - cx * view.scale;
    view.offsetY = h / 2 - cy * view.scale;
  }

  // ---------- Formatting ----------

  function formatDistance(worldLen) {
    const cm = worldLen * state.settings.squareCm;
    if (cm >= 100) {
      const m = cm / 100;
      const rounded = Math.round(m * 100) / 100;
      const txt = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
      return txt.replace(".", ",") + " m";
    }
    const rounded = Math.round(cm * 10) / 10;
    const txt = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return txt.replace(".", ",") + " cm";
  }

  function updateScaleLabel() {
    const cm = state.settings.squareCm;
    const label = cm >= 100 ? `${cm / 100} m` : `${cm} cm`;
    scaleLabel.textContent = `1 quadrado = ${label}`;
  }

  // ---------- Rendering ----------

  function redraw() {
    const { w, h } = viewportSize();
    ctx.clearRect(0, 0, w, h);

    // paper background
    ctx.fillStyle = "#FAFAF7";
    ctx.fillRect(0, 0, w, h);

    drawGrid(w, h);
    drawElements();
    if (strokeState.active) drawPreview();

    emptyHint.classList.toggle("hidden", state.elements.length > 0 || strokeState.active);
  }

  function drawGrid(w, h) {
    const scale = view.scale;
    const startWorld = screenToWorld(0, 0);
    const endWorld = screenToWorld(w, h);

    const minX = Math.floor(startWorld.x) - 1;
    const maxX = Math.ceil(endWorld.x) + 1;
    const minY = Math.floor(startWorld.y) - 1;
    const maxY = Math.ceil(endWorld.y) + 1;

    ctx.lineWidth = 1;
    for (let x = minX; x <= maxX; x++) {
      const sx = Math.round(worldToScreen(x, 0).x) + 0.5;
      ctx.strokeStyle = x % 5 === 0 ? "#93A6B8" : "#C9D3DC";
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
      ctx.stroke();
    }
    for (let y = minY; y <= maxY; y++) {
      const sy = Math.round(worldToScreen(0, y).y) + 0.5;
      ctx.strokeStyle = y % 5 === 0 ? "#93A6B8" : "#C9D3DC";
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
    }

    // origin marker, subtle
    if (scale > 20) {
      const o = worldToScreen(0, 0);
      ctx.fillStyle = "#93A6B8";
      ctx.beginPath();
      ctx.arc(o.x, o.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawElements() {
    for (const el of state.elements) {
      if (el.type === "wall") drawWall(el);
      else if (el.type === "dim") drawDimension(el);
    }
  }

  function drawWall(el) {
    const a = worldToScreen(el.x0, el.y0);
    const b = worldToScreen(el.x1, el.y1);
    ctx.strokeStyle = "#1A2B4C";
    ctx.lineWidth = Math.max(3, view.scale * 0.075);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.fillStyle = "#1A2B4C";
    [a, b].forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, view.scale * 0.045), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawDimension(el) {
    const a = worldToScreen(el.x0, el.y0);
    const b = worldToScreen(el.x1, el.y1);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;

    ctx.strokeStyle = "#E08A2C";
    ctx.fillStyle = "#E08A2C";
    ctx.lineWidth = Math.max(1.4, view.scale * 0.03);

    // main line
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // end ticks (perpendicular)
    const tick = 6;
    [a, b].forEach((p) => {
      ctx.beginPath();
      ctx.moveTo(p.x - nx * tick, p.y - ny * tick);
      ctx.lineTo(p.x + nx * tick, p.y + ny * tick);
      ctx.stroke();
    });

    // label
    const worldLen = Math.hypot(el.x1 - el.x0, el.y1 - el.y0);
    const text = formatDistance(worldLen);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;

    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);
    ctx.font = "600 12.5px " + getMonoFont();
    const metrics = ctx.measureText(text);
    const padX = 6;
    ctx.fillStyle = "#FAFAF7";
    ctx.fillRect(-metrics.width / 2 - padX, -10, metrics.width + padX * 2, 20);
    ctx.fillStyle = "#B96F1E";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function getMonoFont() {
    return 'ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Consolas, monospace';
  }

  function drawPreview() {
    const el = {
      type: state.tool === "measure" ? "dim" : "wall",
      x0: strokeState.start.x,
      y0: strokeState.start.y,
      x1: strokeState.end.x,
      y1: strokeState.end.y,
    };
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([6, 5]);
    if (el.type === "wall") drawWall(el);
    else drawDimension(el);
    ctx.restore();
  }

  // ---------- Interaction ----------

  const pointers = new Map(); // pointerId -> {x,y}
  const strokeState = { active: false, start: null, end: null };
  const panState = { active: false, startScreen: null, startOffset: null };
  const pinchState = { active: false, dist0: 0, mid0: null, view0: null, worldMid0: null };
  const eraseState = { active: false, removedAny: false };

  function getPos(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  function distance(p1, p2) {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  function midpoint(p1, p2) {
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }

  function hitTestElement(worldPos) {
    const thresh = 14 / view.scale; // px converted to world units
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = state.elements.length - 1; i >= 0; i--) {
      const el = state.elements[i];
      const d = distToSegment(worldPos, { x: el.x0, y: el.y0 }, { x: el.x1, y: el.y1 });
      if (d < thresh && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function distToSegment(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t, cy = a.y + aby * t;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  function cancelStroke() {
    strokeState.active = false;
    strokeState.start = null;
    strokeState.end = null;
  }

  function startPinch() {
    const ids = Array.from(pointers.keys());
    const p1 = pointers.get(ids[0]);
    const p2 = pointers.get(ids[1]);
    pinchState.active = true;
    pinchState.dist0 = Math.max(1, distance(p1, p2));
    pinchState.mid0 = midpoint(p1, p2);
    pinchState.view0 = { scale: view.scale, offsetX: view.offsetX, offsetY: view.offsetY };
    pinchState.worldMid0 = screenToWorld(pinchState.mid0.x, pinchState.mid0.y);
    panState.active = false;
    cancelStroke();
    eraseState.active = false;
  }

  function updatePinch() {
    const ids = Array.from(pointers.keys());
    if (ids.length < 2) return;
    const p1 = pointers.get(ids[0]);
    const p2 = pointers.get(ids[1]);
    const dist = Math.max(1, distance(p1, p2));
    const mid = midpoint(p1, p2);
    let newScale = pinchState.view0.scale * (dist / pinchState.dist0);
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    view.scale = newScale;
    view.offsetX = mid.x - pinchState.worldMid0.x * newScale;
    view.offsetY = mid.y - pinchState.worldMid0.y * newScale;
    redraw();
  }

  function onPointerDown(evt) {
    canvas.setPointerCapture(evt.pointerId);
    const pos = getPos(evt);
    pointers.set(evt.pointerId, pos);

    if (pointers.size >= 2) {
      startPinch();
      return;
    }

    if (state.tool === "pan") {
      panState.active = true;
      panState.startScreen = pos;
      panState.startOffset = { x: view.offsetX, y: view.offsetY };
      return;
    }

    if (state.tool === "erase") {
      eraseState.active = true;
      eraseState.removedAny = false;
      const world = screenToWorld(pos.x, pos.y);
      const idx = hitTestElement(world);
      if (idx >= 0) {
        state.elements.splice(idx, 1);
        eraseState.removedAny = true;
        redraw();
      }
      return;
    }

    // draw or measure
    const world = snapPoint(screenToWorld(pos.x, pos.y));
    strokeState.active = true;
    strokeState.start = world;
    strokeState.end = world;
    redraw();
  }

  function onPointerMove(evt) {
    if (!pointers.has(evt.pointerId)) return;
    const pos = getPos(evt);
    pointers.set(evt.pointerId, pos);

    if (pinchState.active && pointers.size >= 2) {
      updatePinch();
      return;
    }

    if (panState.active) {
      view.offsetX = panState.startOffset.x + (pos.x - panState.startScreen.x);
      view.offsetY = panState.startOffset.y + (pos.y - panState.startScreen.y);
      redraw();
      return;
    }

    if (eraseState.active) {
      const world = screenToWorld(pos.x, pos.y);
      const idx = hitTestElement(world);
      if (idx >= 0) {
        state.elements.splice(idx, 1);
        eraseState.removedAny = true;
        redraw();
      }
      return;
    }

    if (strokeState.active) {
      strokeState.end = snapPoint(screenToWorld(pos.x, pos.y));
      redraw();
    }
  }

  function onPointerUp(evt) {
    pointers.delete(evt.pointerId);

    if (pinchState.active) {
      if (pointers.size < 2) {
        pinchState.active = false;
        // resume panning smoothly with any remaining pointer
        if (pointers.size === 1 && state.tool === "pan") {
          const remaining = Array.from(pointers.values())[0];
          panState.active = true;
          panState.startScreen = remaining;
          panState.startOffset = { x: view.offsetX, y: view.offsetY };
        }
      }
      return;
    }

    if (panState.active) {
      panState.active = false;
      return;
    }

    if (eraseState.active) {
      eraseState.active = false;
      if (eraseState.removedAny) pushHistory();
      return;
    }

    if (strokeState.active) {
      const { start, end } = strokeState;
      const len = Math.hypot(end.x - start.x, end.y - start.y);
      if (len >= MIN_SEGMENT_LEN) {
        state.elements.push({
          type: state.tool === "measure" ? "dim" : "wall",
          x0: start.x, y0: start.y, x1: end.x, y1: end.y,
        });
        pushHistory();
      }
      cancelStroke();
      redraw();
    }
  }

  function onPointerCancel(evt) {
    pointers.delete(evt.pointerId);
    cancelStroke();
    panState.active = false;
    pinchState.active = false;
    eraseState.active = false;
    redraw();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // desktop mouse wheel zoom
  canvas.addEventListener(
    "wheel",
    (evt) => {
      evt.preventDefault();
      const pos = getPos(evt);
      const before = screenToWorld(pos.x, pos.y);
      const factor = Math.exp(-evt.deltaY * 0.0016);
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
      view.scale = newScale;
      view.offsetX = pos.x - before.x * newScale;
      view.offsetY = pos.y - before.y * newScale;
      redraw();
    },
    { passive: false }
  );

  // ---------- Toolbar ----------

  toolbar.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tool = btn.dataset.tool;
      toolbar.querySelectorAll(".tool-btn[data-tool]").forEach((b) =>
        b.classList.toggle("is-active", b === btn)
      );
      cancelStroke();
      redraw();
    });
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  clearBtn.addEventListener("click", () => {
    if (state.elements.length === 0) return;
    if (confirm("Apagar tudo? Essa ação não pode ser desfeita depois.")) {
      state.elements = [];
      pushHistory();
      redraw();
      showToast("Folha limpa");
    }
  });

  exportBtn.addEventListener("click", exportPNG);

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  // ---------- Export PNG ----------

  function exportPNG() {
    const exportScale = 3; // resolution multiplier for a crisp saved image
    let minX = 0, minY = 0, maxX = 10, maxY = 10;

    if (state.elements.length > 0) {
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (const el of state.elements) {
        minX = Math.min(minX, el.x0, el.x1);
        maxX = Math.max(maxX, el.x0, el.x1);
        minY = Math.min(minY, el.y0, el.y1);
        maxY = Math.max(maxY, el.y0, el.y1);
      }
    }
    const pad = 1.5;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    const cellPx = 44 * exportScale;
    const outW = Math.max(1, Math.round((maxX - minX) * cellPx));
    const outH = Math.max(1, Math.round((maxY - minY) * cellPx));

    const off = document.createElement("canvas");
    off.width = outW;
    off.height = outH;
    const octx = off.getContext("2d");

    octx.fillStyle = "#FAFAF7";
    octx.fillRect(0, 0, outW, outH);

    const w2s = (x, y) => ({ x: (x - minX) * cellPx, y: (y - minY) * cellPx });

    octx.lineWidth = 1;
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
      const sx = Math.round(w2s(x, 0).x) + 0.5;
      octx.strokeStyle = x % 5 === 0 ? "#93A6B8" : "#C9D3DC";
      octx.beginPath(); octx.moveTo(sx, 0); octx.lineTo(sx, outH); octx.stroke();
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const sy = Math.round(w2s(0, y).y) + 0.5;
      octx.strokeStyle = y % 5 === 0 ? "#93A6B8" : "#C9D3DC";
      octx.beginPath(); octx.moveTo(0, sy); octx.lineTo(outW, sy); octx.stroke();
    }

    for (const el of state.elements) {
      const a = w2s(el.x0, el.y0);
      const b = w2s(el.x1, el.y1);
      if (el.type === "wall") {
        octx.strokeStyle = "#1A2B4C";
        octx.lineWidth = cellPx * 0.075;
        octx.lineCap = "round";
        octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
        octx.fillStyle = "#1A2B4C";
        [a, b].forEach((p) => { octx.beginPath(); octx.arc(p.x, p.y, cellPx * 0.045, 0, Math.PI * 2); octx.fill(); });
      } else {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        octx.strokeStyle = "#E08A2C";
        octx.lineWidth = cellPx * 0.03;
        octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
        const tick = 6 * exportScale;
        [a, b].forEach((p) => {
          octx.beginPath();
          octx.moveTo(p.x - nx * tick, p.y - ny * tick);
          octx.lineTo(p.x + nx * tick, p.y + ny * tick);
          octx.stroke();
        });
        const worldLen = Math.hypot(el.x1 - el.x0, el.y1 - el.y0);
        const text = formatDistance(worldLen);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        let angle = Math.atan2(dy, dx);
        if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
        octx.save();
        octx.translate(mx, my);
        octx.rotate(angle);
        octx.font = `600 ${12.5 * exportScale}px ${getMonoFont()}`;
        const metrics = octx.measureText(text);
        const padX = 6 * exportScale;
        octx.fillStyle = "#FAFAF7";
        octx.fillRect(-metrics.width / 2 - padX, -9 * exportScale, metrics.width + padX * 2, 18 * exportScale);
        octx.fillStyle = "#B96F1E";
        octx.textAlign = "center";
        octx.textBaseline = "middle";
        octx.fillText(text, 0, 0);
        octx.restore();
      }
    }

    off.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      a.href = url;
      a.download = `quadriculado-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast("Imagem salva");
    }, "image/png");
  }

  // ---------- Settings sheet ----------

  function openSettings() {
    refreshOptionSelection();
    settingsBackdrop.classList.add("open");
  }
  function closeSettings() {
    settingsBackdrop.classList.remove("open");
  }
  function refreshOptionSelection() {
    scaleOptions.querySelectorAll(".option-chip").forEach((chip) => {
      chip.classList.toggle("is-selected", Number(chip.dataset.value) === state.settings.squareCm);
    });
    snapOptions.querySelectorAll(".option-chip").forEach((chip) => {
      chip.classList.toggle("is-selected", Number(chip.dataset.value) === state.settings.snapDivisions);
    });
  }

  scaleBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsBackdrop) closeSettings();
  });

  scaleOptions.querySelectorAll(".option-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.settings.squareCm = Number(chip.dataset.value);
      updateScaleLabel();
      refreshOptionSelection();
      save();
      redraw();
    });
  });

  snapOptions.querySelectorAll(".option-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.settings.snapDivisions = Number(chip.dataset.value);
      refreshOptionSelection();
      save();
    });
  });

  // ---------- Resize handling ----------

  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 60));

  // ---------- Init ----------

  function init() {
    load();
    updateScaleLabel();
    toolbar.querySelector('[data-tool="draw"]').classList.add("is-active");
    resizeCanvas();
    fitToElements();
    history.stack = [JSON.stringify(state.elements)];
    history.index = 0;
    updateHistoryButtons();
    redraw();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch(() => {});
      });
    }
  }

  init();
})();
