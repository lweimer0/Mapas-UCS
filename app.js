/* =====================================================================
   TRILHAS UCS — app.js  (versão com mapa ilustrado da UCS, sem Mapbox)
   Procure por "COLOQUE AQUI" para achar o que ainda precisa ser preenchido.
   ===================================================================== */

/* ---------- 1) CONFIGURAÇÃO ---------- */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBu8dt-WUaYIIFxangfUWJfbqu0s-kDph0",
  authDomain: "mapaucs-ed75b.firebaseapp.com",
  projectId: "mapaucs-ed75b",
  storageBucket: "mapaucs-ed75b.firebasestorage.app",
  messagingSenderId: "58460944522",
  appId: "1:58460944522:web:43a49bfa22486bd04c5573"
};

// Link do modelo treinado no Teachable Machine (termina com "/")
const TEACHABLE_MACHINE_MODEL_URL = "COLOQUE_AQUI_O_LINK_DO_MODELO/"; // <- COLOQUE AQUI

// Obras de arte do campus. "label" = nome EXATO da classe no Teachable Machine.
// "imagem" = foto da obra (coloque em /obras/ no repositório). Sem foto, aparece "?".
const TOTAL_FIGURINHAS = 28;   // círculos do álbum (4 colunas x 7 linhas)
const OBRAS_DE_ARTE = [
  { label: "escultura-sol", nome: "Escultura do Sol", artista: "COLOQUE AQUI", descricao: "COLOQUE AQUI", imagem: "obras/escultura-sol.jpg" },
  { label: "mural-entrada", nome: "Mural da Entrada", artista: "COLOQUE AQUI", descricao: "COLOQUE AQUI", imagem: "obras/mural-entrada.jpg" }
];

const VELOCIDADE_A_PE = 1.3;     // m/s (~78 m/min)
const RAIO_CHEGADA = 10;         // metros para considerar que chegou num ponto
const STORAGE_GRAFO = "trilhas_grafo_v1";

/* ---------- 2) ESTADO ---------- */

let DADOS = null;                // { bbox, locais } (dados-campus.json)
let locais = [];                 // blocos e locais com x,y em pixels da imagem
let mpp = 0.5;                   // metros por pixel (calculado)

// pan/zoom
let view = { s: 1, tx: 0, ty: 0 };
const pointers = new Map();

// grafo de caminhos desenhado pelo grupo
let grafo = { nos: [], arestas: [], seq: 1 };   // nos: {id,x,y,loc?}  arestas: [idA,idB]
let editorLigado = false;
let noSelecionado = null;

// seleção / rota / navegação
let localSelecionado = null;
let rotaAtual = null;            // { pts:[{x,y}], metros, reta }
let nav = null;                  // { pts, idx, ativa }
let posUsuario = null;           // {x,y} em pixels
let watchId = null;
let simTimer = null;

let db = null, tmModel = null;

const $ = (id) => document.getElementById(id);

/* ---------- 3) UTILIDADES ---------- */

function geoParaPixel(lat, lng) {
  const b = DADOS.bbox;
  return {
    x: (lng - b.oeste) / (b.leste - b.oeste) * b.largura,
    y: (b.norte - lat) / (b.norte - b.sul) * b.altura
  };
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) * mpp; }   // metros
function normaliza(t) { return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }

function direcao(a, b) {
  const ang = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
  const nomes = ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"];
  return { ang, nome: nomes[Math.round(ang / 45) % 8] };
}

function falar(texto) {
  if (!$("toggle-guia-voz").checked || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = "pt-BR";
  window.speechSynthesis.speak(u);
}
function status(t) { $("user-status").textContent = t; }

/* ---------- 4) TELAS ---------- */

document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => mostrarTela(b.dataset.screen)));

function mostrarTela(nome) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  $(`screen-${nome}`).classList.add("active");
  document.querySelector(`.tab-btn[data-screen="${nome}"]`).classList.add("active");
  if (nome === "scanner") iniciarCamera(); else pararCamera();
  if (nome === "mapa") atualizaTransform();
}

/* ---------- 5) MAPA: pan / zoom ---------- */

function atualizaTransform() {
  const w = $("world");
  w.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.s})`;
  w.style.setProperty("--inv", 1 / view.s);
  w.classList.toggle("perto", view.s > 0.55);
}

function ajustarInicio() {
  const vp = $("viewport").getBoundingClientRect();
  const b = DADOS.bbox;
  // cobre toda a área do mapa e centraliza no meio dos blocos
  view.s = Math.max(vp.width / b.largura, vp.height / b.altura);
  const c = locais.reduce((a, l) => ({ x: a.x + l.x / locais.length, y: a.y + l.y / locais.length }), { x: 0, y: 0 });
  centralizarEm(c, view.s);
}

function zoomEm(fator, cx, cy) {
  const vp = $("viewport").getBoundingClientRect();
  if (cx === undefined) { cx = vp.width / 2; cy = vp.height / 2; }
  const novo = Math.min(Math.max(view.s * fator, 0.15), 2.5);
  const f = novo / view.s;
  view.tx = cx - (cx - view.tx) * f;
  view.ty = cy - (cy - view.ty) * f;
  view.s = novo;
  atualizaTransform();
}

function centralizarEm(p, escala) {
  const vp = $("viewport").getBoundingClientRect();
  if (escala) view.s = escala;
  view.tx = vp.width / 2 - p.x * view.s;
  view.ty = vp.height / 2 - p.y * view.s;
  atualizaTransform();
}

function telaParaMundo(clientX, clientY) {
  const r = $("viewport").getBoundingClientRect();
  return { x: (clientX - r.left - view.tx) / view.s, y: (clientY - r.top - view.ty) / view.s };
}

function iniciarGestos() {
  const vp = $("viewport");
  let inicio = null, moveu = false;

  vp.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".map-controls")) return;   // botões +/−/◎/✎ não contam como toque no mapa
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { inicio = { x: e.clientX, y: e.clientY }; moveu = false; }
    else moveu = true;
  });

  window.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const ant = pointers.get(e.pointerId);
    const atual = { x: e.clientX, y: e.clientY };

    if (pointers.size === 1) {
      view.tx += atual.x - ant.x; view.ty += atual.y - ant.y;
      if (inicio && Math.hypot(atual.x - inicio.x, atual.y - inicio.y) > 6) moveu = true;
      atualizaTransform();
    } else if (pointers.size === 2) {
      const ids = [...pointers.keys()];
      const outro = pointers.get(ids.find(i => i !== e.pointerId));
      const dAnt = Math.hypot(ant.x - outro.x, ant.y - outro.y);
      const dNovo = Math.hypot(atual.x - outro.x, atual.y - outro.y);
      const r = vp.getBoundingClientRect();
      if (dAnt > 0) zoomEm(dNovo / dAnt, (atual.x + outro.x) / 2 - r.left, (atual.y + outro.y) / 2 - r.top);
    }
    pointers.set(e.pointerId, atual);
  });

  const fim = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const eraUnico = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (eraUnico && !moveu && e.type === "pointerup") aoTocarMapa(e.clientX, e.clientY);
  };
  window.addEventListener("pointerup", fim);
  window.addEventListener("pointercancel", fim);

  vp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    zoomEm(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  $("btn-zoom-in").addEventListener("click", () => zoomEm(1.3));
  $("btn-zoom-out").addEventListener("click", () => zoomEm(1 / 1.3));
  $("btn-centralizar").addEventListener("click", () => {
    if (posUsuario) centralizarEm(posUsuario, Math.max(view.s, 0.8));
    else status("sem localização ainda");
  });
}

/* ---------- 6) PINS e SELEÇÃO ---------- */

function desenharPins() {
  const box = $("pins");
  box.innerHTML = "";
  locais.forEach(l => {
    const d = document.createElement("div");
    d.className = `pin t${l.tipo}`;
    d.dataset.id = l.id;
    d.style.left = l.x + "px"; d.style.top = l.y + "px";
    d.innerHTML = `<span class="rot">${l.nome}</span>`;
    box.appendChild(d);
  });
  const dl = $("lista-locais");
  dl.innerHTML = "";
  [...locais].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")).forEach(l => {
    const o = document.createElement("option"); o.value = l.nome; dl.appendChild(o);
  });
}

function acharLocalPorNome(txt) {
  const t = normaliza(txt);
  if (!t) return null;
  return locais.find(l => normaliza(l.nome) === t) || locais.find(l => normaliza(l.nome).includes(t)) || null;
}

function localMaisProximo(p, raioPx) {
  let melhor = null, d0 = raioPx;
  locais.forEach(l => { const d = Math.hypot(l.x - p.x, l.y - p.y); if (d < d0) { d0 = d; melhor = l; } });
  return melhor;
}

function selecionarLocal(l) {
  localSelecionado = l;
  document.querySelectorAll(".pin.sel").forEach(p => p.classList.remove("sel"));
  const el = document.querySelector(`.pin[data-id="${l.id}"]`);
  if (el) el.classList.add("sel");
  $("destino-input").value = l.nome;
  mostrarSheetLocal(l);
}

const TIPOS = { 1: "Bloco ou prédio", 2: "Setor ou área", 3: "Laboratório ou secretaria", 4: "Sala, auditório ou terceirizado" };

function sheet(titulo, sub, botoes) {
  $("sheet").hidden = false;
  $("sheet-titulo").textContent = titulo;
  $("sheet-sub").textContent = sub;
  const c = $("sheet-botoes"); c.innerHTML = "";
  botoes.forEach(b => {
    const el = document.createElement("button");
    el.textContent = b.texto; if (b.sec) el.className = "sec";
    el.addEventListener("click", b.fn); c.appendChild(el);
  });
}

function mostrarSheetLocal(l) {
  sheet(l.nome, TIPOS[l.tipo] || "Local", [
    { texto: "Rota até aqui", fn: () => { $("destino-input").value = l.nome; tracarRota(); } },
    { texto: "Partir daqui", sec: true, fn: () => { $("origem-input").value = l.nome; status("origem: " + l.nome); } }
  ]);
}

/* ---------- 7) GRAFO DE CAMINHOS (editor) ---------- */

function salvarGrafo() { try { localStorage.setItem(STORAGE_GRAFO, JSON.stringify(grafo)); } catch (e) {} }

async function carregarGrafo() {
  try {
    const salvo = localStorage.getItem(STORAGE_GRAFO);
    if (salvo) { grafo = JSON.parse(salvo); return; }
  } catch (e) {}
  try {                                   // caminhos.json publicado junto com o site
    const r = await fetch("caminhos.json", { cache: "no-store" });
    if (r.ok) grafo = await r.json();
  } catch (e) {}
}

const noPorId = (id) => grafo.nos.find(n => n.id === id);

function desenharGrafo() {
  const svg = $("overlay");
  const b = DADOS.bbox;
  svg.setAttribute("viewBox", `0 0 ${b.largura} ${b.altura}`);
  svg.setAttribute("width", b.largura); svg.setAttribute("height", b.altura);
  let h = "";
  if (editorLigado) {
    grafo.arestas.forEach(([a, c]) => {
      const A = noPorId(a), C = noPorId(c); if (!A || !C) return;
      h += `<line x1="${A.x}" y1="${A.y}" x2="${C.x}" y2="${C.y}" stroke="#e63946" stroke-width="${3 / view.s}" stroke-linecap="round"/>`;
    });
    grafo.nos.forEach(n => {
      const sel = n.id === noSelecionado;
      h += `<circle cx="${n.x}" cy="${n.y}" r="${(sel ? 8 : 5) / view.s}" fill="${sel ? "#e9c46a" : "#fff"}" stroke="#e63946" stroke-width="${2 / view.s}"/>`;
    });
  }
  if (rotaAtual) {
    const pts = rotaAtual.pts.map(p => `${p.x},${p.y}`).join(" ");
    h += `<polyline points="${pts}" fill="none" stroke="#fff" stroke-width="${9 / view.s}" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>`;
    h += `<polyline points="${pts}" fill="none" stroke="#2a6f97" stroke-width="${5 / view.s}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${12 / view.s} ${9 / view.s}"/>`;
  }
  svg.innerHTML = h;
}
// redesenha com espessura certa quando o zoom muda
const _atualiza = atualizaTransform;
atualizaTransform = function () { _atualiza(); if (DADOS && (editorLigado || rotaAtual)) desenharGrafo(); };

function atualizaContador() {
  $("editor-contador").textContent = `(${grafo.nos.length} pontos, ${grafo.arestas.length} trechos)`;
}

function noPerto(p, raioPx) {
  let m = null, d0 = raioPx;
  grafo.nos.forEach(n => { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < d0) { d0 = d; m = n; } });
  return m;
}

function ligar(a, b) {
  if (!a || !b || a === b) return;
  const existe = grafo.arestas.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (!existe) grafo.arestas.push([a, b]);
}

function aoTocarMapa(cx, cy) {
  const p = telaParaMundo(cx, cy);
  const alcance = 16 / view.s;

  if (editorLigado) {
    let no = noPerto(p, alcance);
    if (!no) {
      const l = localMaisProximo(p, alcance);
      if (l) {                                         // usa o bloco como ponto do grafo
        no = grafo.nos.find(n => n.loc === l.id);
        if (!no) { no = { id: "L" + l.id, x: l.x, y: l.y, loc: l.id }; grafo.nos.push(no); }
      } else {
        no = { id: "W" + (grafo.seq++), x: Math.round(p.x), y: Math.round(p.y) };
        grafo.nos.push(no);
      }
    }
    if (noSelecionado && noSelecionado !== no.id) ligar(noSelecionado, no.id);
    noSelecionado = no.id;
    salvarGrafo(); atualizaContador(); desenharGrafo();
    return;
  }

  const l = localMaisProximo(p, alcance * 1.3);
  if (l) selecionarLocal(l);
}

function iniciarEditor() {
  $("btn-editor").addEventListener("click", () => {
    editorLigado = !editorLigado;
    $("btn-editor").classList.toggle("ativo", editorLigado);
    $("editor-panel").hidden = !editorLigado;
    noSelecionado = null; atualizaContador(); desenharGrafo();
  });
  $("ed-terminar").addEventListener("click", () => { noSelecionado = null; desenharGrafo(); });
  $("ed-apagar").addEventListener("click", () => {
    if (!noSelecionado) return alert("Toque num ponto para selecioná-lo antes de apagar.");
    grafo.nos = grafo.nos.filter(n => n.id !== noSelecionado);
    grafo.arestas = grafo.arestas.filter(([a, b]) => a !== noSelecionado && b !== noSelecionado);
    noSelecionado = null; salvarGrafo(); atualizaContador(); desenharGrafo();
  });
  $("ed-limpar").addEventListener("click", () => {
    if (!confirm("Apagar TODOS os caminhos desenhados neste aparelho?")) return;
    grafo = { nos: [], arestas: [], seq: 1 }; noSelecionado = null;
    salvarGrafo(); atualizaContador(); desenharGrafo();
  });
  $("ed-exportar").addEventListener("click", () => {
    const txt = JSON.stringify(grafo);
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "application/json" }));
    a.download = "caminhos.json"; a.click();
    alert("Arquivo caminhos.json baixado (e copiado). Suba ele para o repositório, na mesma pasta do index.html, para todos verem os caminhos.");
  });
  $("ed-importar").addEventListener("click", () => $("ed-arquivo").click());
  $("ed-arquivo").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { grafo = JSON.parse(await f.text()); salvarGrafo(); atualizaContador(); desenharGrafo(); }
    catch (err) { alert("Arquivo inválido."); }
  });
}

/* ---------- 8) ROTA (Dijkstra) ---------- */

function noMaisProximoDe(p) {
  let m = null, d0 = Infinity;
  grafo.nos.forEach(n => { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < d0) { d0 = d; m = n; } });
  return m;
}

function dijkstra(origemId, destinoId) {
  const adj = {};
  grafo.nos.forEach(n => adj[n.id] = []);
  grafo.arestas.forEach(([a, b]) => {
    const A = noPorId(a), B = noPorId(b); if (!A || !B) return;
    const d = dist(A, B); adj[a].push([b, d]); adj[b].push([a, d]);
  });
  const D = {}, prev = {}, nv = new Set(grafo.nos.map(n => n.id));
  nv.forEach(i => D[i] = Infinity); D[origemId] = 0;
  while (nv.size) {
    let u = null; nv.forEach(i => { if (u === null || D[i] < D[u]) u = i; });
    if (D[u] === Infinity) break;
    nv.delete(u); if (u === destinoId) break;
    adj[u].forEach(([v, w]) => { if (D[u] + w < D[v]) { D[v] = D[u] + w; prev[v] = u; } });
  }
  if (D[destinoId] === Infinity) return null;
  const caminho = []; for (let c = destinoId; c; c = prev[c]) caminho.unshift(c);
  return caminho.map(noPorId);
}

function comprimento(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

function tracarRota() {
  const dest = acharLocalPorNome($("destino-input").value);
  if (!dest) return alert("Escolha um destino da lista (comece a digitar o nome do bloco).");

  let origemPt, origemNome;
  const txtOrigem = $("origem-input").value.trim();
  if (txtOrigem) {
    const o = acharLocalPorNome(txtOrigem);
    if (!o) return alert("Origem não encontrada. Deixe vazio para usar sua localização.");
    origemPt = { x: o.x, y: o.y }; origemNome = o.nome;
  } else if (posUsuario) { origemPt = posUsuario; origemNome = "sua localização"; }
  else return alert("Sem localização do GPS ainda. Escolha uma origem na lista (campo \"De:\").");

  const destPt = { x: dest.x, y: dest.y };
  let pts = null, reta = false;

  if (grafo.nos.length >= 2) {
    const nA = noMaisProximoDe(origemPt), nB = noMaisProximoDe(destPt);
    const caminho = nA && nB ? dijkstra(nA.id, nB.id) : null;
    if (caminho) pts = [origemPt, ...caminho, destPt];
  }
  if (!pts) { pts = [origemPt, destPt]; reta = true; }

  rotaAtual = { pts, metros: comprimento(pts), reta, destino: dest.nome };
  desenharGrafo();
  centralizarEm({ x: (origemPt.x + destPt.x) / 2, y: (origemPt.y + destPt.y) / 2 }, Math.min(view.s, 0.9));

  const min = Math.max(1, Math.round(rotaAtual.metros / VELOCIDADE_A_PE / 60));
  sheet(`${dest.nome}`, `${Math.round(rotaAtual.metros)} m · ${min} min a pé` +
        (reta ? " · linha reta (desenhem os caminhos no editor ✎)" : ""), [
    { texto: "Iniciar trajeto", fn: iniciarTrajeto },
    { texto: "Cancelar", sec: true, fn: cancelarTrajeto }
  ]);
}

/* ---------- 9) NAVEGAÇÃO ---------- */

function iniciarTrajeto() {
  if (!rotaAtual) return;
  nav = { pts: rotaAtual.pts.slice(), idx: 1, destino: rotaAtual.destino };
  mostrarTela("rota");
  falar(`Trajeto iniciado até ${nav.destino}. ${Math.round(rotaAtual.metros)} metros.`);
  if (posUsuario) atualizarNavegacao(); else {
    $("nav-texto").textContent = "Aguardando sua localização… (ou use Simular caminhada)";
  }
}

function cancelarTrajeto() {
  nav = null; rotaAtual = null; pararSimulacao();
  $("sheet").hidden = true; desenharGrafo();
  $("nav-distancia").textContent = "-- m"; $("nav-restante").textContent = "";
  $("nav-texto").textContent = "Nenhum trajeto ativo. Escolha um destino na aba Mapa.";
  mostrarTela("mapa");
}

function atualizarNavegacao() {
  if (!nav || !posUsuario) return;
  while (nav.idx < nav.pts.length - 1 && dist(posUsuario, nav.pts[nav.idx]) < RAIO_CHEGADA) {
    nav.idx++;
    const prox = nav.pts[nav.idx], d = direcao(posUsuario, prox);
    falar(`Siga para o ${d.nome} por ${Math.round(dist(posUsuario, prox))} metros.`);
  }
  const alvo = nav.pts[nav.idx];
  const d = dist(posUsuario, alvo);

  if (nav.idx === nav.pts.length - 1 && d < RAIO_CHEGADA) {
    $("nav-seta").textContent = "✔"; $("nav-seta").style.transform = "none";
    $("nav-distancia").textContent = "Chegou!"; $("nav-texto").textContent = nav.destino;
    $("nav-restante").textContent = "";
    falar(`Você chegou ao destino: ${nav.destino}.`);
    pararSimulacao(); nav = null; return;
  }
  const dir = direcao(posUsuario, alvo);
  $("nav-seta").textContent = "↑"; $("nav-seta").style.transform = `rotate(${dir.ang}deg)`;
  $("nav-distancia").textContent = `${Math.round(d)} m`;
  $("nav-texto").textContent = `Siga para o ${dir.nome}`;
  let resta = d; for (let i = nav.idx; i < nav.pts.length - 1; i++) resta += dist(nav.pts[i], nav.pts[i + 1]);
  $("nav-restante").textContent = `Faltam ${Math.round(resta)} m até ${nav.destino}`;
}

/* ---------- 10) POSIÇÃO DO USUÁRIO (GPS) e SIMULAÇÃO ---------- */

function atualizaOrigem() { $("origem-input").hidden = !!posUsuario; }

function colocarUsuario(p) {
  posUsuario = p; atualizaOrigem();
  const me = $("me"); me.hidden = false; me.style.left = p.x + "px"; me.style.top = p.y + "px";
  atualizarNavegacao();
}

function iniciarGPS() {
  if (!("geolocation" in navigator)) return status("sem geolocalização");
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (simTimer) return;                       // simulação manda na posição
      const p = geoParaPixel(pos.coords.latitude, pos.coords.longitude);
      const b = DADOS.bbox, m = 200;
      const dentro = p.x > -m && p.x < b.largura + m && p.y > -m && p.y < b.altura + m;
      if (dentro) { colocarUsuario(p); status("localização ativa"); }
      else status("você está fora do campus");
    },
    () => status("permissão de localização negada"),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function pararSimulacao() {
  if (simTimer) { clearInterval(simTimer); simTimer = null; $("btn-simular").textContent = "Simular caminhada (teste em casa)"; }
}

$("btn-simular").addEventListener("click", () => {
  if (simTimer) return pararSimulacao();
  if (!nav) return alert("Trace uma rota e toque em \"Iniciar trajeto\" primeiro.");
  const pts = nav.pts; let seg = 0, t = 0;
  $("btn-simular").textContent = "Parar simulação";
  colocarUsuario({ x: pts[0].x, y: pts[0].y });
  simTimer = setInterval(() => {
    if (!nav) return pararSimulacao();
    const A = pts[seg], B = pts[seg + 1]; if (!B) return pararSimulacao();
    t += (6 / dist(A, B)) * 0.4;                  // ~6 m/s simulados
    if (t >= 1) { seg++; t = 0; if (!pts[seg + 1]) { colocarUsuario({ x: pts[seg].x, y: pts[seg].y }); return pararSimulacao(); } }
    const a = pts[seg], b = pts[seg + 1];
    colocarUsuario({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }, 400);
});

$("btn-buscar-rota").addEventListener("click", tracarRota);
$("btn-iniciar-trajeto") && $("btn-iniciar-trajeto").addEventListener("click", iniciarTrajeto);
$("btn-cancelar-trajeto").addEventListener("click", cancelarTrajeto);

/* ---------- 11) ÁLBUM + FIREBASE ---------- */

function iniciarFirebase() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    firebase.auth().signInAnonymously().catch(e => console.warn("Firebase auth:", e));
    firebase.auth().onAuthStateChanged(u => { if (u) carregarAlbum(u.uid); });
  } catch (e) { console.warn("Firebase indisponível:", e); }
  renderizarAlbum([]);
}

async function carregarAlbum(uid) {
  try {
    const doc = await db.collection("usuarios").doc(uid).get();
    renderizarAlbum(doc.exists ? (doc.data().figurinhas || []) : []);
  } catch (e) { console.warn(e); }
}

async function desbloquearFigurinha(label) {
  const u = firebase.auth().currentUser; if (!u || !db) return;
  const ref = db.collection("usuarios").doc(u.uid);
  await ref.set({ figurinhas: firebase.firestore.FieldValue.arrayUnion(label) }, { merge: true });
  const doc = await ref.get(); renderizarAlbum(doc.data().figurinhas || []);
}

function renderizarAlbum(des) {
  const g = $("album-grid"); g.innerHTML = "";
  for (let i = 0; i < TOTAL_FIGURINHAS; i++) {
    const o = OBRAS_DE_ARTE[i];
    const ok = !!o && des.includes(o.label);
    const d = document.createElement("div");
    d.className = `sticker ${ok ? "unlocked" : "locked"}`;
    if (o && o.imagem) {
      const img = document.createElement("img");
      img.src = o.imagem; img.alt = ok ? o.nome : "Obra bloqueada";
      img.onerror = () => { img.remove(); d.textContent = ok ? o.nome : "?"; };
      d.appendChild(img);
    } else d.textContent = o && ok ? o.nome : "?";
    g.appendChild(d);
  }
}

/* ---------- 12) SCANNER (Teachable Machine) ---------- */

async function carregarModelo() {
  if (TEACHABLE_MACHINE_MODEL_URL.includes("COLOQUE_AQUI")) return;
  try { tmModel = await tmImage.load(TEACHABLE_MACHINE_MODEL_URL + "model.json", TEACHABLE_MACHINE_MODEL_URL + "metadata.json"); }
  catch (e) { console.warn("Modelo TM:", e); }
}

async function iniciarCamera() {
  const v = $("scanner-video"); if (v.srcObject) return;
  try { v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
  catch (e) { $("scanner-resultado").textContent = "Não foi possível acessar a câmera. Verifique a permissão."; }
}
function pararCamera() {
  const v = $("scanner-video");
  if (v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
}

$("btn-escanear").addEventListener("click", async () => {
  const out = $("scanner-resultado");
  if (!tmModel) { out.textContent = "O modelo de reconhecimento ainda não foi configurado."; return; }
  const v = $("scanner-video"), c = $("scanner-canvas");
  c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
  const pred = await tmModel.predict(c);
  const melhor = pred.reduce((a, b) => a.probability > b.probability ? a : b);
  const obra = melhor.probability > 0.8 && OBRAS_DE_ARTE.find(o => o.label === melhor.className);
  if (obra) {
    out.textContent = `Reconhecida: ${obra.nome} — ${obra.artista}. ${obra.descricao}`;
    await desbloquearFigurinha(obra.label); falar(`Você desbloqueou a figurinha ${obra.nome}`);
  } else out.textContent = "Não reconheci essa obra, tente chegar mais perto ou melhorar a iluminação.";
});

/* ---------- 13) INICIALIZAÇÃO ---------- */

window.addEventListener("DOMContentLoaded", async () => {
  iniciarFirebase(); carregarModelo();
  try {
    DADOS = await (await fetch("dados-campus.json")).json();
  } catch (e) { status("erro ao carregar dados do campus"); return; }

  const b = DADOS.bbox;
  const mLat = (b.norte - b.sul) * 111320 / b.altura;
  const mLng = (b.leste - b.oeste) * 111320 * Math.cos(b.norte * Math.PI / 180) / b.largura;
  mpp = (mLat + mLng) / 2;

  locais = DADOS.locais;
  $("world").style.width = b.largura + "px"; $("world").style.height = b.altura + "px";
  desenharPins();
  await carregarGrafo(); atualizaContador();
  iniciarGestos(); iniciarEditor();
  ajustarInicio(); desenharGrafo();
  atualizaOrigem();
  iniciarGPS();
});
