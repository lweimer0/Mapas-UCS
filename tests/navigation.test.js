const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadNavigation(voices = []) {
  const spoken = [];
  const alerts = [];
  let cancelCalls = 0;
  const elements = new Map();
  const speechSynthesis = {
    getVoices() { return voices; },
    speak(utterance) { spoken.push(utterance); },
    cancel() { cancelCalls++; }
  };
  const element = () => ({
    checked: true,
    value: "externo",
    innerHTML: "",
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {} },
    dataset: {},
    appendChild(child) { if (child.value === "auto") this.value = "auto"; },
    setAttribute() {},
    click() {}
  });
  const document = {
    querySelectorAll() { return []; },
    querySelector() { return element(); },
    createElement() { return element(); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }
  };
  const window = { addEventListener() {}, speechSynthesis };
  class Utterance {
    constructor(text) { this.text = text; }
  }
  const sandbox = {
    document,
    window,
    navigator: {},
    SpeechSynthesisUtterance: Utterance,
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch: async () => ({ ok: false }),
    console,
    alert(message) { alerts.push(message); },
    Math,
    Date,
    Set,
    Map
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const bridge = `
    globalThis.navigationTestApi = {
      element(id) { return $(id); },
      setGraph(nodes, edges) { grafo = { nos: nodes, arestas: edges, seq: 1 }; mpp = 1; },
      setLocations(items) { locais = items; },
      setPosition(point) { posUsuario = point; },
      setData(data) { DADOS = data; },
      setRoute(route) { rotaAtual = route; },
      setNavigation(value) { nav = value; },
      desenharGrafo,
      dijkstra, rotaNoGrafo, planejarRota, tracarRota, limparCamposRota, escolherVoz, configurarEnunciado,
      iniciarTrajeto, cancelarTrajeto, atualizarNavegacao, orientarGiro, pontosDeOrientacao, textoOrientacao, alertasDaRota, falar, falarAlerta,
      getSpeechState() { return { falaAtiva, falaOrientacaoPendente, filaAlertas: filaAlertas.slice() }; }
    };
  `;
  vm.runInNewContext(`${source}\n${bridge}`, sandbox, { filename: "app.js" });
  return { api: sandbox.navigationTestApi, elements, spoken, alerts, getCancelCalls: () => cancelCalls };
}

test("turn instructions are relative and simplify straight segments", () => {
  const { api } = loadNavigation();
  assert.equal(api.orientarGiro({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }), "à direita");
  assert.equal(api.orientarGiro({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: -10 }), "à esquerda");
  assert.equal(api.orientarGiro({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }), "em meia-volta");
  const pts = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 1 },
    { x: 20, y: 12 }, { x: 20, y: 20 }
  ];
  assert.deepEqual(Array.from(api.pontosDeOrientacao(pts), p => p.indice), [0, 2, 4]);
});

test("Dijkstra preserves the type of each selected route segment", () => {
  const { api } = loadNavigation();
  api.setGraph(
    [{ id: "A", x: 0, y: 0 }, { id: "B", x: 0, y: 15 }, { id: "C", x: 0, y: 10 }, { id: "D", x: 10, y: 10 }],
    [["A", "B", "escadaria"], ["B", "D", "rua"], ["A", "C", "interno"], ["C", "D", "interno"]]
  );
  const route = api.dijkstra("A", "D");
  assert.deepEqual(Array.from(route, p => p.id), ["A", "C", "D"]);
  assert.equal(route[1].tipoAresta, "interno");
  assert.equal(route[2].tipoAresta, "interno");
  assert.equal(api.dijkstra("A", "missing"), null);
});

test("routes use mapped location anchors and never add straight endpoint connectors", () => {
  const { api } = loadNavigation();
  api.setGraph(
    [
      { id: "L1", x: 0, y: 0 },
      { id: "N1", x: 10, y: 0 },
      { id: "N2", x: 10, y: 10 },
      { id: "L2", x: 20, y: 10 }
    ],
    [["L1", "N1", "acesso"], ["N1", "N2", "externo"], ["N2", "L2", "acesso"]]
  );
  const route = api.rotaNoGrafo({ id: 1 }, { id: 2 });
  assert.deepEqual(Array.from(route, node => node.id), ["L1", "N1", "N2", "L2"]);
  assert.equal(route.some(node => node.x === 1 && node.y === 9), false);
  assert.equal(api.rotaNoGrafo({ id: 999 }, { id: 2 }), null);
});

test("each planned route uses fresh explicit origin and destination text", () => {
  const { api } = loadNavigation();
  const places = [
    { id: 1, nome: "Bloco A", x: 0, y: 0 },
    { id: 2, nome: "Bloco B", x: 10, y: 0 },
    { id: 3, nome: "Bloco C", x: 20, y: 10 }
  ];
  api.setLocations(places);
  api.setGraph(
    [{ id: "L1", x: 0, y: 0 }, { id: "N1", x: 5, y: 0 }, { id: "L2", x: 10, y: 0 }, { id: "L3", x: 20, y: 10 }],
    [["L1", "N1", "acesso"], ["N1", "L2", "externo"], ["L2", "L3", "externo"]]
  );
  api.setPosition({ x: 0, y: 0 });

  const first = api.planejarRota("Bloco A", "Bloco B");
  assert.deepEqual(Array.from(first.pts, node => node.id), ["L1", "N1", "L2"]);
  api.element("origem-input").value = "Bloco A";
  api.element("destino-input").value = "Bloco B";
  api.setRoute({ ...first, metros: 10 });
  api.iniciarTrajeto();
  assert.equal(api.element("origem-input").value, "");
  assert.equal(api.element("destino-input").value, "");

  assert.equal(api.planejarRota("", "Bloco C"), null);
  const second = api.planejarRota("Bloco B", "Bloco C");
  assert.deepEqual(Array.from(second.pts, node => node.id), ["L2", "L3"]);
  assert.equal(second.origem.nome, "Bloco B");
  assert.equal(second.destino.nome, "Bloco C");
});

test("GPS does not silently replace an empty origin field", () => {
  const { api, alerts } = loadNavigation();
  api.setPosition({ x: 10, y: 10 });
  api.element("origem-input").value = "";
  api.element("destino-input").value = "Bloco C";
  api.tracarRota();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Informe de onde/);
});

test("cancelling and completing a route clear endpoint fields", () => {
  const { api } = loadNavigation();
  api.setGraph([], []);
  api.setData({ bbox: { largura: 100, altura: 100 } });
  api.element("origem-input").value = "Bloco A";
  api.element("destino-input").value = "Bloco B";
  api.cancelarTrajeto();
  assert.equal(api.element("origem-input").value, "");
  assert.equal(api.element("destino-input").value, "");

  api.element("origem-input").value = "Bloco B";
  api.element("destino-input").value = "Bloco C";
  api.setRoute({ pts: [{ x: 0, y: 0, id: "L2" }, { x: 10, y: 0, id: "L3" }], metros: 5, destino: "Bloco C", origem: "Bloco B" });
  api.setNavigation({ pts: [{ x: 0, y: 0, id: "L2" }, { x: 10, y: 0, id: "L3" }], idx: 1, destino: "Bloco C", alertas: [], alertasEmitidos: new Set(), ultimaFala: 0, ultimaInstrucao: "", ultimoTurno: null });
  api.setPosition({ x: 10, y: 0 });
  api.atualizarNavegacao();
  assert.equal(api.element("origem-input").value, "");
  assert.equal(api.element("destino-input").value, "");
});

test("GPS origin must be close to the mapped network and is snapped to a real graph node", () => {
  const { api } = loadNavigation();
  api.setGraph(
    [{ id: "N1", x: 10, y: 0 }, { id: "N2", x: 20, y: 0 }, { id: "L2", x: 30, y: 0 }],
    [["N1", "N2", "externo"], ["N2", "L2", "acesso"]]
  );
  const route = api.rotaNoGrafo({ ponto: { x: 11, y: 0 } }, { id: 2 });
  assert.deepEqual(Array.from(route, node => node.id), ["N1", "N2", "L2"]);
  assert.equal(api.rotaNoGrafo({ ponto: { x: 100, y: 100 } }, { id: 2 }), null);
});

test("spoken guidance uses distance and relative turns, not compass directions", () => {
  const { api } = loadNavigation();
  api.setGraph([], []);
  const text = api.textoOrientacao({
    pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    idx: 1,
    destino: "Biblioteca"
  }, 10);
  assert.match(text, /Siga em frente por 10 metros/);
  assert.match(text, /vire à direita/);
  assert.doesNotMatch(text, /norte|sul|leste|oeste/i);
});

test("route alerts are placed before hazard segments and adjacent warnings are grouped", () => {
  const { api } = loadNavigation();
  const alerts = api.alertasDaRota([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0, tipoAresta: "travessia" },
    { x: 30, y: 0, tipoAresta: "travessia" },
    { x: 40, y: 0 },
    { x: 50, y: 0, tipoAresta: "escadaria" },
    { x: 60, y: 0 }
  ]);
  assert.equal(alerts.length, 2);
  assert.deepEqual({ x: alerts[0].ponto.x, y: alerts[0].ponto.y }, { x: 10, y: 0 });
  assert.match(alerts[0].texto, /travessia de rua/);
  assert.deepEqual({ x: alerts[1].ponto.x, y: alerts[1].ponto.y }, { x: 40, y: 0 });
  assert.match(alerts[1].texto, /escadaria/);
});

test("voice queues hazard alerts without cancelling active guidance", () => {
  const { api, spoken, getCancelCalls } = loadNavigation();
  api.falar("Siga em frente por 20 metros.");
  api.falarAlerta("Atenção: travessia de rua à frente.", "crossing-1");
  api.falar("Siga em frente por 10 metros.");

  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "Siga em frente por 20 metros.");
  assert.equal(getCancelCalls(), 0);

  spoken[0].onend();
  assert.equal(spoken[1].text, "Atenção: travessia de rua à frente.");
  spoken[1].onend();
  assert.equal(spoken[2].text, "Siga em frente por 10 metros.");
});

test("automatic voice prefers Brazilian Portuguese, then Portuguese, then browser default", () => {
  const { api } = loadNavigation();
  const voices = [
    { voiceURI: "en", lang: "en-US", default: true },
    { voiceURI: "pt-pt", lang: "pt-PT", default: false },
    { voiceURI: "pt-br", lang: "pt-BR", default: false }
  ];
  assert.equal(api.escolherVoz(voices).voiceURI, "pt-br");
  assert.equal(api.escolherVoz(voices.slice(0, 2)).voiceURI, "pt-pt");
  assert.equal(api.escolherVoz(voices.slice(0, 1)).voiceURI, "en");
  assert.equal(api.escolherVoz(voices, "pt-pt").voiceURI, "pt-pt");
  assert.equal(api.escolherVoz(voices, "unavailable").voiceURI, "pt-br");
});

test("voice settings apply selected native voice and bounded speaking rate", () => {
  const voice = { voiceURI: "pt-br", lang: "pt-BR" };
  const { api, spoken } = loadNavigation([voice]);
  api.element("voice-rate").value = "1.25";
  api.configurarEnunciado(spoken);
  assert.equal(spoken.lang, "pt-BR");
  assert.equal(spoken.voice, voice);
  assert.equal(spoken.rate, 1.25);
  api.element("voice-rate").value = "0.5";
  api.configurarEnunciado(spoken);
  assert.equal(spoken.rate, 0.75);
});

test("public map hides the full editable graph and exposes no path editor controls", () => {
  const { api, elements } = loadNavigation();
  api.setGraph(
    [{ id: "A", x: 0, y: 0 }, { id: "B", x: 10, y: 10 }],
    [["A", "B", "externo"]]
  );
  api.setData({ bbox: { largura: 100, altura: 100 } });
  api.desenharGrafo();
  assert.equal(elements.get("overlay").innerHTML, "");

  api.setRoute({ pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }], metros: 10, destino: "B" });
  api.desenharGrafo();
  assert.equal((elements.get("overlay").innerHTML.match(/<polyline/g) || []).length, 2);
  assert.doesNotMatch(elements.get("overlay").innerHTML, /<line\b|<circle\b/);

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.doesNotMatch(html, /btn-editor|editor-panel|editor-tipo|ed-importar|ed-exportar|ed-arquivo/);
  assert.doesNotMatch(app, /iniciarEditor|localStorage\.getItem\(["']trilhas_grafo/);
  assert.doesNotMatch(styles, /\.editor-panel|\.editor-help|\.editor-buttons/);
});
