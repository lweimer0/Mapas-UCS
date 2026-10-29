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
const RAIO_ALERTA = 22;
const LIMITE_ANCORAGEM_GPS = 35;
const INTERVALO_ORIENTACAO = 10000;
const TIPOS_CAMINHO = {
  escadaria: { alerta: "Atenção: escadaria à frente." },
  rampa: { alerta: "Atenção: rampa à frente." },
  rua: { alerta: "Atenção: travessia de rua à frente. Pare, verifique o trânsito e atravesse com cuidado." },
  travessia: { alerta: "Atenção: travessia de rua à frente. Pare, verifique o trânsito e atravesse com cuidado." },
  atencao: { alerta: "Atenção: local que exige cuidado à frente." }
};

/* ---------- 2) ESTADO ---------- */

let DADOS = null;                // { bbox, locais } (dados-campus.json)
let locais = [];                 // blocos e locais com x,y em pixels da imagem
let mpp = 0.5;                   // metros por pixel (calculado)

// pan/zoom
let view = { s: 1, tx: 0, ty: 0 };
const pointers = new Map();

// Rede oficial de caminhos usada no roteamento
let grafo = { nos: [], arestas: [], seq: 1 };   // nos: {id,x,y,loc?}  arestas: [idA,idB]

// seleção / rota / navegação
let localSelecionado = null;
let rotaAtual = null;            // { pts:[{x,y}], metros, reta }
let nav = null;                  // { pts, idx, ativa }
let posUsuario = null;           // {x,y} em pixels
let watchId = null;
let simTimer = null;
let falaAtiva = false;
let enunciadoAtivo = null;
let falaOrientacaoPendente = "";
let filaAlertas = [];
let vozesDisponiveis = [];
let idVozSelecionada = "feminina";
let avisoFallbackVoz = "";

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
function normaliza(t) { return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim(); }

function direcao(a, b) {
  const ang = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
  return { ang };
}

function escolherVoz(voices, preferredId = "feminina") {
  if (preferredId !== "feminina" && preferredId !== "masculina") return null;
  const padraoGenero = preferredId === "masculina"
    ? /\b(male|man|masculino|daniel|antonio|antônio|ricardo|felipe|joao|joão|paulo|marcos|gustavo|bruno|rafael|pedro|eduardo|carlos|thiago|tiago)\b/i
    : /\b(female|woman|feminina|maria|luciana|francisca|camila|heloisa|heloísa|vitoria|vitória|bruna|fernanda|ana|joana|isabela|isabella|bianca|carolina)\b/i;
  return voices.find(voice => /^pt[-_]BR$/i.test(voice.lang) && padraoGenero.test(`${voice.name} ${voice.voiceURI}`)) || null;
}

function atualizarListaVozes() {
  if (!("speechSynthesis" in window) || typeof window.speechSynthesis.getVoices !== "function") return;
  vozesDisponiveis = window.speechSynthesis.getVoices().filter(voice => /^pt[-_]BR$/i.test(voice.lang));
  const select = $("voice-select");
  if (!select) return;
  select.value = idVozSelecionada;
}

function configurarEnunciado(utterance) {
  utterance.lang = "pt-BR";
  utterance.voice = escolherVoz(vozesDisponiveis, idVozSelecionada);
  const taxa = Number($("voice-rate").value);
  utterance.rate = Number.isFinite(taxa) ? Math.min(1.25, Math.max(0.75, taxa)) : 0.95;
  if (utterance.voice) {
    avisoFallbackVoz = "";
    utterance.pitch = 1;
  } else {
    utterance.pitch = idVozSelecionada === "masculina" ? 0.8 : 1.15;
    if (avisoFallbackVoz !== idVozSelecionada) {
      status(`voz ${idVozSelecionada} pt-BR indisponível; usando fala sintetizada padrão do navegador`);
      avisoFallbackVoz = idVozSelecionada;
    }
  }
}

function desbloquearSinteseDeVoz() {
  if (!("speechSynthesis" in window)) return false;
  const sintese = window.speechSynthesis;
  if (typeof sintese.resume === "function") sintese.resume();
  return true;
}

function processarFilaDeFala() {
  if (falaAtiva || !$("toggle-guia-voz").checked || !("speechSynthesis" in window)) return;
  const alerta = filaAlertas.shift();
  const texto = alerta ? alerta.texto : falaOrientacaoPendente;
  if (!texto) return;
  if (!alerta) falaOrientacaoPendente = "";
  const u = new SpeechSynthesisUtterance(texto);
  configurarEnunciado(u);
  falaAtiva = true;
  enunciadoAtivo = u;
  const concluir = () => {
    if (enunciadoAtivo !== u) return;
    enunciadoAtivo = null;
    falaAtiva = false;
    processarFilaDeFala();
  };
  u.onend = concluir;
  u.onerror = (event) => {
    if (enunciadoAtivo !== u) return;
    status(`erro no guia por voz${event && event.error ? `: ${event.error}` : ""}`);
    concluir();
  };
  try {
    desbloquearSinteseDeVoz();
    window.speechSynthesis.speak(u);
  } catch (error) {
    status("não foi possível iniciar o guia por voz");
    concluir();
    console.error("Speech synthesis error:", error);
  }
}

function falar(texto) {
  if (!$("toggle-guia-voz").checked) return;
  if (!("speechSynthesis" in window)) {
    status("guia por voz indisponível neste navegador");
    return;
  }
  falaOrientacaoPendente = texto;
  processarFilaDeFala();
}

function falarAlerta(texto, id) {
  if (!$("toggle-guia-voz").checked) return;
  if (!("speechSynthesis" in window)) {
    status("guia por voz indisponível neste navegador");
    return;
  }
  if (filaAlertas.some(alerta => alerta.id === id)) return;
  filaAlertas.push({ id, texto });
  processarFilaDeFala();
}

function pararGuiaVoz() {
  falaOrientacaoPendente = "";
  filaAlertas = [];
  falaAtiva = false;
  enunciadoAtivo = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function tipoAresta(aresta) {
  return Array.isArray(aresta) ? aresta[2] || "caminho" : aresta.tipo || "caminho";
}

function arestaAlternativa(aresta) {
  const tags = Array.isArray(aresta) ? aresta[3] : aresta.tags;
  const classificacoes = [tipoAresta(aresta), ...(Array.isArray(tags) ? tags : [])];
  return classificacoes.some(classificacao => {
    const normalizado = normaliza(String(classificacao)).replace(/[_-]+/g, " ");
    return /^(?:(?:caminho|rota)\s+)?alternativ[oa]s?$/.test(normalizado);
  });
}

function pontasAresta(aresta) {
  return Array.isArray(aresta)
    ? { a: aresta[0], b: aresta[1] }
    : { a: aresta.de, b: aresta.para };
}

function orientarGiro(anteriorA, anteriorB, proximo) {
  const a = { x: anteriorB.x - anteriorA.x, y: anteriorB.y - anteriorA.y };
  const b = { x: proximo.x - anteriorB.x, y: proximo.y - anteriorB.y };
  const cruzado = a.x * b.y - a.y * b.x;
  const alinhamento = a.x * b.x + a.y * b.y;
  const angulo = Math.abs(Math.atan2(cruzado, alinhamento) * 180 / Math.PI);
  if (angulo < 30) return "";
  if (angulo > 150) return "em meia-volta";
  return cruzado > 0 ? "à direita" : "à esquerda";
}

function instrucaoDeGiro(giro) {
  return giro === "em meia-volta" ? "faça meia-volta" : `vire ${giro}`;
}

function pontosDeOrientacao(pts) {
  if (pts.length < 3) return pts.map((p, i) => ({ ...p, indice: i }));
  const indices = new Set([0, pts.length - 1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const giro = orientarGiro(pts[i - 1], pts[i], pts[i + 1]);
    if (giro || pts[i + 1].tipoAresta && TIPOS_CAMINHO[pts[i + 1].tipoAresta]?.alerta) {
      indices.add(i);
    }
  }
  return [...indices].sort((a, b) => a - b).map(i => ({ ...pts[i], indice: i }));
}

function textoOrientacao(navAtual, distancia) {
  const destino = navAtual.pts[navAtual.idx];
  const anterior = navAtual.pts[navAtual.idx - 1];
  const seguinte = navAtual.pts[navAtual.idx + 1];
  const giro = seguinte ? orientarGiro(anterior, destino, seguinte) : "";
  const giroAtual = navAtual.ultimoTurno && dist(posUsuario, navAtual.ultimoTurno.ponto) <= RAIO_ALERTA
    ? `${instrucaoDeGiro(navAtual.ultimoTurno.direcao)}. `
    : "";
  let texto = `${giroAtual}Siga em frente por ${Math.max(1, Math.round(distancia))} metros`;
  if (giro) texto += `. Depois, ${instrucaoDeGiro(giro)}`;
  else if (!seguinte) texto += ` até ${navAtual.destino}`;
  return texto + ".";
}

function alertasDaRota(pts) {
  const alertas = [];
  let alertaAnterior = "";
  for (let i = 2; i < pts.length - 1; i++) {
    const tipo = pts[i].tipoAresta;
    const texto = tipo && TIPOS_CAMINHO[tipo]?.alerta;
    if (texto && tipo !== alertaAnterior) alertas.push({ id: `${i}:${tipo}`, indice: i - 1, ponto: pts[i - 1], texto });
    alertaAnterior = texto ? tipo : "";
  }
  return alertas;
}

function status(t) { $("user-status").textContent = t; }

/* ---------- 4) TELAS ---------- */

document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
  mostrarTela(b.dataset.screen);
  if (b.dataset.screen === "rota") ativarGuiaAoEntrar();
}));

function ativarGuiaAoEntrar() {
  idVozSelecionada = $("voice-select").value || idVozSelecionada;
  desbloquearSinteseDeVoz();
  atualizarListaVozes();
  if (nav && posUsuario) {
    nav.ultimaFala = 0;
    atualizarNavegacao();
  } else if (nav) {
    falar("Guia por voz ativo. Aguardando sua localização para iniciar as orientações.");
  } else {
    falar("Guia por voz ativo. Escolha um destino e inicie um trajeto para receber orientações.");
  }
}

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
  limitarMapaAoViewport();
  const w = $("world");
  w.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.s})`;
  w.style.setProperty("--inv", 1 / view.s);
  w.classList.toggle("perto", view.s > 0.55);
}

function limitarMapaAoViewport() {
  if (!DADOS) return;
  const vp = $("viewport").getBoundingClientRect();
  const b = DADOS.bbox;
  const escalaMinima = Math.max(vp.width / b.largura, vp.height / b.altura);
  view.s = Math.max(escalaMinima, Math.min(view.s, 2.5));
  view.tx = Math.min(0, Math.max(vp.width - b.largura * view.s, view.tx));
  view.ty = Math.min(0, Math.max(vp.height - b.altura * view.s, view.ty));
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
  const b = DADOS.bbox;
  const minimo = Math.max(vp.width / b.largura, vp.height / b.altura);
  const novo = Math.max(minimo, Math.min(view.s * fator, 2.5));
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
  locais.flatMap(nomesDoLocal).sort((a, b) => a.localeCompare(b, "pt-BR")).forEach(nome => {
    const o = document.createElement("option"); o.value = nome; dl.appendChild(o);
  });
}

function nomesDoLocal(l) {
  return [l.nome, ...(Array.isArray(l.apelidos) ? l.apelidos : [])];
}

function acharLocalPorNome(txt) {
  const t = normaliza(txt);
  if (!t) return null;
  return locais.find(l => nomesDoLocal(l).some(n => normaliza(n) === t))
    || locais.find(l => nomesDoLocal(l).some(n => normaliza(n).includes(t)))
    || null;
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

/* ---------- 7) REDE OFICIAL DE CAMINHOS ---------- */

async function carregarGrafo() {
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
  if (rotaAtual) {
    const pts = rotaAtual.pts.map(p => `${p.x},${p.y}`).join(" ");
    h += `<polyline points="${pts}" fill="none" stroke="#fff" stroke-width="9" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>`;
    h += `<polyline points="${pts}" fill="none" stroke="#2a6f97" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="12 9"/>`;
  }
  svg.innerHTML = h;
}

function aoTocarMapa(cx, cy) {
  const p = telaParaMundo(cx, cy);
  const alcance = 16 / view.s;
  const l = localMaisProximo(p, alcance * 1.3);
  if (l) selecionarLocal(l);
}

/* ---------- 8) ROTA (Dijkstra) ---------- */

function noMaisProximoDe(p) {
  let m = null, d0 = Infinity;
  grafo.nos.forEach(n => { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < d0) { d0 = d; m = n; } });
  return m;
}

function rotaNoGrafo(origem, destino, evitar = $("evitar-alternativos").checked) {
  const temPontoGPS = !!origem.ponto;
  const noOrigem = temPontoGPS ? noMaisProximoDe(origem.ponto) : noPorId(`L${origem.id}`);
  const noDestino = noPorId(`L${destino.id}`);
  if (!noOrigem || !noDestino) return null;
  if (temPontoGPS && dist(origem.ponto, noOrigem) > LIMITE_ANCORAGEM_GPS) return null;
  const caminho = dijkstra(noOrigem.id, noDestino.id, evitar);
  return caminho && caminho.length > 1 ? caminho : null;
}

function dijkstra(origemId, destinoId, evitarAlternativos = false) {
  const adj = {};
  grafo.nos.forEach(n => adj[n.id] = []);
  grafo.arestas.forEach(aresta => {
    const { a, b } = pontasAresta(aresta);
    const A = noPorId(a), B = noPorId(b); if (!A || !B) return;
    const d = dist(A, B), tipo = tipoAresta(aresta);
    if (evitarAlternativos && arestaAlternativa(aresta)) return;
    adj[a].push([b, d, tipo]); adj[b].push([a, d, tipo]);
  });
  if (!Object.prototype.hasOwnProperty.call(adj, origemId) ||
      !Object.prototype.hasOwnProperty.call(adj, destinoId)) return null;
  const D = {}, prev = {}, nv = new Set(grafo.nos.map(n => n.id));
  nv.forEach(i => D[i] = Infinity); D[origemId] = 0;
  while (nv.size) {
    let u = null; nv.forEach(i => { if (u === null || D[i] < D[u]) u = i; });
    if (D[u] === Infinity) break;
    nv.delete(u); if (u === destinoId) break;
    adj[u].forEach(([v, w, tipo]) => {
      if (D[u] + w < D[v]) { D[v] = D[u] + w; prev[v] = { no: u, tipo }; }
    });
  }
  if (D[destinoId] === Infinity) return null;
  const caminho = [];
  for (let c = destinoId; c !== origemId;) {
    const anterior = prev[c];
    if (!anterior) return null;
    caminho.unshift({ ...noPorId(c), tipoAresta: anterior.tipo });
    c = anterior.no;
  }
  return [noPorId(origemId), ...caminho];
}

function comprimento(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

function planejarRota(origemTexto, destinoTexto, evitar) {
  if (!origemTexto.trim() || !destinoTexto.trim()) return null;
  const origem = acharLocalPorNome(origemTexto);
  const destino = acharLocalPorNome(destinoTexto);
  if (!origem || !destino) return null;
  const caminho = rotaNoGrafo(origem, destino, evitar);
  return caminho ? { origem, destino, pts: caminho.map(no => ({ ...no })) } : null;
}

function limparCamposRota() {
  $("origem-input").value = "";
  $("destino-input").value = "";
}

function tracarRota() {
  const txtOrigem = $("origem-input").value.trim();
  const txtDestino = $("destino-input").value.trim();
  if (!txtOrigem) return alert("Informe de onde você vai sair para criar cada nova rota.");
  const localOrigem = acharLocalPorNome(txtOrigem);
  if (!localOrigem) return alert("Origem não encontrada. Escolha um local da lista.");
  if (!txtDestino) return alert("Informe o destino da rota.");
  const localDestino = acharLocalPorNome(txtDestino);
  if (!localDestino) return alert("Destino não encontrado. Escolha um local da lista.");
  if (localOrigem.id === localDestino.id) {
    return alert("A origem e o destino são o mesmo local. Escolha um destino diferente para criar a rota.");
  }

  const planejamento = planejarRota(txtOrigem, txtDestino);
  if (!planejamento) {
    if ($("evitar-alternativos").checked && planejarRota(txtOrigem, txtDestino, false)) {
      return alert("Não há caminho sem trechos alternativos até esse destino. Desmarque \"evitar caminhos alternativos\" para ver a rota disponível e, se precisar, peça assistência presencial.");
    }
    return alert("Não há um caminho mapeado conectado entre esses locais.");
  }
  const { origem, destino: dest, pts } = planejamento;
  rotaAtual = { pts, metros: comprimento(pts), destino: dest.nome, origem: origem.nome };
  desenharGrafo();
  const limites = pts.reduce((b, p) => ({
    minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x),
    minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y)
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  centralizarEm({ x: (limites.minX + limites.maxX) / 2, y: (limites.minY + limites.maxY) / 2 }, Math.min(view.s, 0.9));

  const min = Math.max(1, Math.round(rotaAtual.metros / VELOCIDADE_A_PE / 60));
  sheet(`${dest.nome}`, `${Math.round(rotaAtual.metros)} m · ${min} min a pé`, [
    { texto: "Iniciar trajeto", fn: iniciarTrajeto },
    { texto: "Cancelar", sec: true, fn: cancelarTrajeto }
  ]);
}

/* ---------- 9) NAVEGAÇÃO ---------- */

function iniciarTrajeto() {
  if (!rotaAtual) return;
  idVozSelecionada = $("voice-select").value || idVozSelecionada;
  atualizarListaVozes();
  desbloquearSinteseDeVoz();
  const rota = pontosDeOrientacao(rotaAtual.pts);
  const alertas = alertasDaRota(rotaAtual.pts);
  nav = { pts: rota, idx: 1, destino: rotaAtual.destino, alertas, alertasEmitidos: new Set(), ultimaFala: 0, ultimaInstrucao: "", ultimoTurno: null };
  limparCamposRota();
  $("nav-alerta").textContent = "";
  mostrarTela("rota");
  falar(`Trajeto iniciado de ${rotaAtual.origem} até ${nav.destino}. ${Math.round(rotaAtual.metros)} metros.`);
  if (posUsuario) atualizarNavegacao(); else {
    $("nav-texto").textContent = "Aguardando sua localização… (ou use Simular caminhada)";
    falar("Aguardando sua localização para iniciar as orientações.");
  }
}

function cancelarTrajeto() {
  nav = null; rotaAtual = null; pararSimulacao();
  pararGuiaVoz();
  limparCamposRota();
  $("sheet").hidden = true; desenharGrafo();
  $("nav-seta").textContent = "↑"; $("nav-seta").style.transform = "none";
  $("nav-distancia").textContent = "-- m"; $("nav-restante").textContent = "";
  $("nav-texto").textContent = "Nenhum trajeto ativo. Escolha um destino na aba Mapa.";
  mostrarTela("mapa");
}

function atualizarNavegacao() {
  if (!nav || !posUsuario) return;
  nav.alertas.forEach(alerta => {
    const indiceAtual = nav.pts[nav.idx].indice;
    if (indiceAtual <= alerta.indice && !nav.alertasEmitidos.has(alerta.id) && dist(posUsuario, alerta.ponto) <= RAIO_ALERTA) {
      nav.alertasEmitidos.add(alerta.id);
      $("nav-alerta").textContent = alerta.texto;
      falarAlerta(alerta.texto, alerta.id);
    }
  });
  while (nav.idx < nav.pts.length - 1 && dist(posUsuario, nav.pts[nav.idx]) < RAIO_CHEGADA) {
    const ponto = nav.pts[nav.idx];
    const anterior = nav.pts[nav.idx - 1];
    const seguinte = nav.pts[nav.idx + 1];
    const giro = seguinte && orientarGiro(anterior, ponto, seguinte);
    if (giro) nav.ultimoTurno = { ponto, direcao: giro };
    nav.idx++;
    nav.ultimaInstrucao = "";
  }
  const alvo = nav.pts[nav.idx];
  const d = dist(posUsuario, alvo);

  if (nav.idx === nav.pts.length - 1 && d < RAIO_CHEGADA) {
    $("nav-seta").textContent = "✔"; $("nav-seta").style.transform = "none";
    $("nav-distancia").textContent = "Chegou!"; $("nav-texto").textContent = nav.destino;
    $("nav-restante").textContent = ""; $("nav-alerta").textContent = "";
    falar(`Você chegou ao destino: ${nav.destino}.`);
    pararSimulacao(); nav = null; rotaAtual = null;
    limparCamposRota();
    $("sheet").hidden = true;
    desenharGrafo();
    return;
  }
  const dir = direcao(posUsuario, alvo);
  $("nav-seta").textContent = "↑"; $("nav-seta").style.transform = `rotate(${dir.ang}deg)`;
  $("nav-distancia").textContent = `${Math.round(d)} m`;
  const instrucao = textoOrientacao(nav, d);
  $("nav-texto").textContent = instrucao;
  let resta = d; for (let i = nav.idx; i < nav.pts.length - 1; i++) resta += dist(nav.pts[i], nav.pts[i + 1]);
  $("nav-restante").textContent = `Faltam ${Math.round(resta)} m até ${nav.destino}`;
  const agora = Date.now();
  if (instrucao !== nav.ultimaInstrucao || agora - nav.ultimaFala >= INTERVALO_ORIENTACAO) {
    nav.ultimaInstrucao = instrucao;
    nav.ultimaFala = agora;
    falar(instrucao);
  }
}

/* ---------- 10) POSIÇÃO DO USUÁRIO (GPS) e SIMULAÇÃO ---------- */

function atualizaOrigem() { $("origem-input").hidden = false; }

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
    (erro) => {
      if (erro && erro.code === 1) status("permissão de localização negada");
      else if (erro && erro.code === 3) status("tempo esgotado ao obter a localização; tentando de novo…");
      else status("localização indisponível no momento");
    },
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
$("btn-cancelar-trajeto").addEventListener("click", cancelarTrajeto);
$("voice-select").addEventListener("change", () => {
  idVozSelecionada = $("voice-select").value || "feminina";
  avisoFallbackVoz = "";
});
$("voice-rate").addEventListener("input", () => {
  $("voice-rate-value").textContent = `${Number($("voice-rate").value).toFixed(2).replace(".", ",")}×`;
});
$("toggle-guia-voz").addEventListener("change", () => {
  if (!$("toggle-guia-voz").checked) pararGuiaVoz();
  else {
    desbloquearSinteseDeVoz();
    if (nav && posUsuario) { nav.ultimaFala = 0; atualizarNavegacao(); }
    else falar("Guia por voz ativado.");
  }
});

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = atualizarListaVozes;
  atualizarListaVozes();
}

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
  await carregarGrafo();
  iniciarGestos();
  ajustarInicio(); desenharGrafo();
  atualizaOrigem();
  iniciarGPS();
});