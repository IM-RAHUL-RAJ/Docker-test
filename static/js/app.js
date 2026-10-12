// RDS Explorer front-end
// - talks to the Flask JSON API (/api/...)
// - draws a 3D "skyline" of every table, and a 3D bar chart for a chosen table
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/* ============================================================
   1. Small helpers
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());
const PALETTE = [0x6ee7ff, 0xa78bfa, 0xf472b6, 0x34d399, 0xfbbf24, 0x60a5fa, 0xfb7185];

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showError(err) {
  const box = $("#error");
  box.textContent = "⚠ " + err.message;
  box.classList.remove("hidden");
}

const state = {
  overview: null,
  current: null,   // { schema, table, details }
  page: 1,
  size: 50,
};

/* ============================================================
   2. The 3D scene (Three.js)
   ============================================================ */
const container = $("#scene");
const tooltip = $("#tooltip");

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x050810, 60, 160);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
camera.position.set(22, 20, 28);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;
controls.maxPolarAngle = Math.PI / 2.1;

scene.add(new THREE.AmbientLight(0x8899ff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(20, 40, 15);
scene.add(key);
const rim = new THREE.PointLight(0xa78bfa, 2, 80);
rim.position.set(-20, 15, -20);
scene.add(rim);

// glowing grid floor
const grid = new THREE.GridHelper(120, 60, 0x2a3a7a, 0x141c3a);
scene.add(grid);

// floating particles for atmosphere
(() => {
  const g = new THREE.BufferGeometry();
  const pts = new Float32Array(900 * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = (Math.random() - 0.5) * (i % 3 === 1 ? 60 : 120) + (i % 3 === 1 ? 30 : 0);
  g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x6ee7ff, size: 0.12, transparent: true, opacity: 0.5 })));
})();

const world = new THREE.Group();   // everything we rebuild lives in here
scene.add(world);
let pickables = [];                // meshes the mouse can hover / click

function clearWorld() {
  world.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); });
  world.clear();
  pickables = [];
}

// A text label rendered on a canvas and shown as a sprite (always faces the camera)
function makeLabel(text, color = "#e6ebff", scale = 1) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const font = "500 44px 'Space Grotesk', sans-serif";
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 24;
  c.height = 64;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 12, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set((c.width / 64) * scale, scale, 1);
  return sprite;
}

// One glowing bar = box + bright edges
function makeBar(w, h, d, color) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, metalness: 0.3, roughness: 0.35, transparent: true, opacity: 0.88 })
  );
  mesh.position.y = h / 2;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  edges.position.copy(mesh.position);
  group.add(mesh, edges);
  group.userData.mesh = mesh;
  return group;
}

// Bars grow from the floor when a scene is built
let growing = [];
function animateGrow(group) {
  group.scale.y = 0.001;
  growing.push({ group, t: 0 });
}

// Bars are at most ~12 units tall, so keep the camera far enough to see the tops
function fitCamera(radius) {
  const r = Math.max(radius, 16);
  camera.position.set(r * 0.9, r * 0.75, r * 1.25);
  controls.target.set(0, 4.5, 0);
}

/* ---------- Mode A: skyline of all tables ---------- */
function buildSkyline(overview) {
  clearWorld();
  const tables = overview.schemas.flatMap((s, si) => s.tables.map((t) => ({ ...t, schema: s.name, si })));
  if (!tables.length) return;

  const maxRows = Math.max(1, ...tables.map((t) => t.rows || 0));
  const heightOf = (rows) => 0.6 + (Math.log10((rows || 0) + 1) / Math.log10(maxRows + 1)) * 12; // log scale

  // Each schema is a row ("district"); tables are towers along it
  const gap = 3.2;
  const widest = Math.max(...overview.schemas.map((s) => s.tables.length), 1);
  overview.schemas.forEach((schema, si) => {
    const z = (si - (overview.schemas.length - 1) / 2) * gap * 1.6;
    const color = PALETTE[si % PALETTE.length];

    const label = makeLabel(schema.name, "#" + color.toString(16).padStart(6, "0"), 1.1);
    label.position.set(-(widest * gap) / 2 - 3, 0.8, z);
    world.add(label);

    schema.tables.forEach((t, ti) => {
      const x = (ti - (schema.tables.length - 1) / 2) * gap;
      const bar = makeBar(1.8, heightOf(t.rows), 1.8, color);
      bar.position.set(x, 0, z);
      bar.userData.mesh.userData = {
        tip: `${schema.name}.${t.name}\n${fmt(t.rows)} rows · ${t.columns} cols`,
        onClick: () => openTable(schema.name, t.name),
      };
      pickables.push(bar.userData.mesh);
      world.add(bar);
      animateGrow(bar);

      const name = makeLabel(t.name, "#e6ebff", 0.7);
      name.position.set(x, heightOf(t.rows) + 0.8, z);
      world.add(name);
    });
  });
  fitCamera(Math.max(widest * gap, overview.schemas.length * gap * 1.6) * 0.9);
}

/* ---------- Mode B: 3D bar chart of one table ---------- */
function buildBarChart(items, valueLabel) {
  clearWorld();
  if (!items.length) {
    const l = makeLabel("No numeric data to chart", "#8b95b8", 1.4);
    l.position.set(0, 3, 0);
    world.add(l);
    return;
  }
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const gap = 2.2;
  items.forEach((item, i) => {
    const h = 0.2 + (Math.abs(item.value) / max) * 12;
    const color = new THREE.Color().setHSL(0.52 + (i / items.length) * 0.35, 0.85, 0.62).getHex();
    const bar = makeBar(1.4, h, 1.4, color);
    bar.position.set((i - (items.length - 1) / 2) * gap, 0, 0);
    bar.userData.mesh.userData = { tip: `${item.label}\n${valueLabel}: ${fmt(item.value)}` };
    pickables.push(bar.userData.mesh);
    world.add(bar);
    animateGrow(bar);

    const val = makeLabel(fmt(Math.round(item.value * 100) / 100), "#e6ebff", 0.55);
    val.position.set(bar.position.x, h + 0.7, 0);
    world.add(val);

    const lab = makeLabel(String(item.label).slice(0, 14), "#8b95b8", 0.55);
    lab.position.set(bar.position.x, -0.1, 1.6);
    world.add(lab);
  });
  fitCamera(items.length * gap * 0.6);
}

/* ---------- hover + click ---------- */
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hovered = null;

renderer.domElement.addEventListener("pointermove", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(pickables)[0]?.object || null;

  if (hovered && hovered !== hit) hovered.material.emissiveIntensity = 0.25;
  hovered = hit;
  if (hit) {
    hit.material.emissiveIntensity = 0.9;
    tooltip.innerText = hit.userData.tip;
    tooltip.style.left = e.clientX - r.left + 14 + "px";
    tooltip.style.top = e.clientY - r.top + 14 + "px";
    tooltip.style.opacity = 1;
    renderer.domElement.style.cursor = hit.userData.onClick ? "pointer" : "default";
  } else {
    tooltip.style.opacity = 0;
    renderer.domElement.style.cursor = "grab";
  }
});
renderer.domElement.addEventListener("click", () => hovered?.userData.onClick?.());
renderer.domElement.addEventListener("pointerdown", () => (controls.autoRotate = false));

/* ---------- render loop ---------- */
function resize() {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  growing = growing.filter((g) => {
    g.t = Math.min(g.t + dt * 1.6, 1);
    g.group.scale.y = 1 - Math.pow(1 - g.t, 3); // ease-out
    return g.t < 1;
  });
  controls.update();
  renderer.render(scene, camera);
});

/* ============================================================
   3. UI: sidebar, stats, data grid, structure
   ============================================================ */
function renderStats(o) {
  const tables = o.schemas.flatMap((s) => s.tables);
  const rows = tables.reduce((a, t) => a + (t.rows || 0), 0);
  $("#stats").innerHTML = [
    ["Engine", o.engine, true],
    ["Database", o.database || "—", true],
    ["Schemas", fmt(o.schemas.length)],
    ["Tables", fmt(tables.length)],
    ["Total rows", fmt(rows)],
  ].map(([l, v, small]) => `<div class="stat"><div class="label">${l}</div><div class="value ${small ? "small" : ""}">${v}</div></div>`).join("");
}

function renderTree(filter = "") {
  const f = filter.toLowerCase();
  $("#tree").innerHTML = state.overview.schemas.map((s) => {
    const items = s.tables.filter((t) => t.name.toLowerCase().includes(f));
    if (!items.length && f) return "";
    return `<div class="schema">
      <div class="schema-name"><span>▾ ${s.name}</span><span>${s.tables.length}</span></div>
      ${items.map((t) => `<div class="table-item" data-schema="${s.name}" data-table="${t.name}">
          <span>${t.name}</span><span class="count">${fmt(t.rows)}</span></div>`).join("")}
    </div>`;
  }).join("") || `<div class="hint">No tables found.</div>`;
  markActive();
}

function markActive() {
  document.querySelectorAll(".table-item").forEach((el) => {
    const c = state.current;
    el.classList.toggle("active", !!c && el.dataset.schema === c.schema && el.dataset.table === c.table);
  });
}

$("#tree").addEventListener("click", (e) => {
  const item = e.target.closest(".table-item");
  if (item) openTable(item.dataset.schema, item.dataset.table);
  const head = e.target.closest(".schema-name");
  if (head) head.parentElement.querySelectorAll(".table-item").forEach((el) => el.classList.toggle("hidden"));
});
$("#search").addEventListener("input", (e) => renderTree(e.target.value));

async function openTable(schema, table) {
  try {
    $("#error").classList.add("hidden");
    const details = await api(`/api/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}`);
    state.current = { schema, table, details };
    state.page = 1;
    markActive();
    $("#table-view").classList.remove("hidden");
    $("#table-title").textContent = `${schema}.${table}`;
    renderStructure(details);
    setupViz(details);
    await loadRows();
  } catch (err) { showError(err); }
}

async function loadRows() {
  const { schema, table } = state.current;
  const data = await api(`/api/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/rows?page=${state.page}&size=${state.size}`);
  const kinds = Object.fromEntries(state.current.details.columns.map((c) => [c.name, c.kind]));
  const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  $("#grid").innerHTML =
    `<thead><tr>${data.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>` +
    `<tbody>${data.rows.map((r) => `<tr>${r.map((v, i) => {
      if (v === null) return `<td class="null">null</td>`;
      const text = typeof v === "object" ? JSON.stringify(v) : v;
      return `<td class="${kinds[data.columns[i]] === "number" ? "num" : ""}" title="${esc(text)}">${esc(text)}</td>`;
    }).join("")}</tr>`).join("")}</tbody>`;

  const pages = Math.max(1, Math.ceil(data.total / data.size));
  $("#page-info").textContent = `page ${data.page} / ${fmt(pages)} · ${fmt(data.total)} rows`;
  $("#prev").disabled = data.page <= 1;
  $("#next").disabled = data.page >= pages;
}

$("#prev").onclick = () => { state.page--; loadRows().catch(showError); };
$("#next").onclick = () => { state.page++; loadRows().catch(showError); };
$("#page-size").onchange = (e) => { state.size = +e.target.value; state.page = 1; loadRows().catch(showError); };

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  $("#tab-data").classList.toggle("hidden", tab.dataset.tab !== "data");
  $("#tab-structure").classList.toggle("hidden", tab.dataset.tab !== "structure");
}));

function renderStructure(d) {
  const cols = d.columns.map((c) => `<tr>
      <td>${c.name}${c.primary_key ? '<span class="badge pk">PK</span>' : ""}</td>
      <td>${c.type}<span class="badge kind-${c.kind}">${c.kind}</span></td>
      <td>${c.nullable ? "yes" : "no"}</td>
      <td>${c.default ?? ""}</td></tr>`).join("");
  const fks = d.foreign_keys.length
    ? d.foreign_keys.map((f) => `<div class="hint">(${f.columns.join(", ")}) → ${f.ref_schema}.${f.ref_table}(${f.ref_columns.join(", ")})</div>`).join("")
    : `<div class="hint">None</div>`;
  const idx = d.indexes.length
    ? d.indexes.map((i) => `<div class="hint">${i.name} (${i.columns.join(", ")})${i.unique ? " · unique" : ""}</div>`).join("")
    : `<div class="hint">None</div>`;
  $("#structure").innerHTML = `<div class="structure">
    <div class="panel-head"><h2>${d.schema}.${d.table}</h2><div class="hint">${fmt(d.rows)} rows · ${d.columns.length} columns</div></div>
    <div class="grid-wrap"><table class="grid"><thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead><tbody>${cols}</tbody></table></div>
    <h3>Foreign keys</h3>${fks}<h3>Indexes</h3>${idx}</div>`;
}

/* ============================================================
   4. Per-table 3D visualisation
   ============================================================ */
let vizRows = null;

function setupViz(details) {
  const cols = details.columns;
  const numeric = cols.filter((c) => c.kind === "number" && !c.primary_key);
  const labels = cols.filter((c) => c.kind !== "number" || c.primary_key);

  $("#x-col").innerHTML = (labels.length ? labels : cols).map((c) => `<option>${c.name}</option>`).join("");
  $("#y-col").innerHTML = `<option value="__count__">COUNT of rows</option>` +
    numeric.map((c) => `<option value="${c.name}">SUM of ${c.name}</option>`).join("");
  // prefer a "real" measure (amount, price…) over id-like columns (customer_id…)
  const measure = numeric.find((c) => !/(^id$|_id$)/i.test(c.name)) || numeric[0];
  if (measure) $("#y-col").value = measure.name;

  $("#viz-controls").classList.remove("hidden");
  $("#scene-title").textContent = `${details.schema}.${details.table} — 3D chart`;
  $("#scene-hint").textContent = "Grouped from a sample of up to 1,000 rows · hover a bar for its value";
  vizRows = null;
  drawTableChart();
}

async function drawTableChart() {
  const { schema, table } = state.current;
  if (!vizRows) {
    vizRows = await api(`/api/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/rows?page=1&size=1000`);
  }
  const xi = vizRows.columns.indexOf($("#x-col").value);
  const yName = $("#y-col").value;
  const yi = vizRows.columns.indexOf(yName);

  const groups = new Map();
  for (const row of vizRows.rows) {
    let label = row[xi] ?? "(null)";
    if (typeof label === "string" && /^\d{4}-\d{2}-\d{2}T/.test(label)) label = label.slice(0, 10); // dates → day
    const add = yName === "__count__" ? 1 : Number(row[yi]) || 0;
    groups.set(label, (groups.get(label) || 0) + add);
  }
  const items = [...groups].map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 30); // top 30 keeps the scene readable
  controls.autoRotate = true;
  buildBarChart(items, yName === "__count__" ? "rows" : `sum(${yName})`);
}

$("#x-col").onchange = () => drawTableChart().catch(showError);
$("#y-col").onchange = () => drawTableChart().catch(showError);
$("#back-skyline").onclick = () => {
  $("#viz-controls").classList.add("hidden");
  $("#scene-title").textContent = "Database skyline";
  $("#scene-hint").textContent = "Each tower is a table · height = rows · drag to orbit · click a tower to open it";
  controls.autoRotate = true;
  buildSkyline(state.overview);
};

/* ============================================================
   5. Start
   ============================================================ */
(async function init() {
  try {
    state.overview = await api("/api/overview");
    const o = state.overview;
    $("#conn").innerHTML = `<span class="dot"></span>${o.engine} · ${o.host || "local"} / ${o.database || ""}`;
    renderStats(o);
    renderTree();
    buildSkyline(o);
  } catch (err) {
    $("#conn").textContent = "not connected";
    showError(err);
  }
})();
