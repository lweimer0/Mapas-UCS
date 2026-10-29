const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadNavigation(voices = [], speechSupported = true) {
  const spoken = [];
  const alerts = [];
  let cancelCalls = 0;
  let resumeCalls = 0;
  const elements = new Map();
  const speechSynthesis = {
    paused: true,
    getVoices() { return voices; },
    speak(utterance) { spoken.push(utterance); },
    cancel() { cancelCalls++; },
    resume() { resumeCalls++; this.paused = false; }
  };
  const element = () => ({
    checked: true,
    value: "externo",
    innerHTML: "",
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {} },
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0 }; },
    dataset: {},
    appendChild(child) { if (child.value) this.value = child.value; },
    setAttribute() {},
    click() {}
  });
  const document = {
    querySelectorAll() { return []; },
    querySelector() { return element(); },
    createElement() { return element(); },
    getElementById(id) {
      if (!elements.has(id)) {
        const created = element();
        if (id === "evitar-alternativos") created.checked = false;
        elements.set(id, created);
      }
      return elements.get(id);
    }
  };
  const window = { addEventListener() {} };
  if (speechSupported) window.speechSynthesis = speechSynthesis;
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
      setAvoidAlternatives(value) { $("evitar-alternativos").checked = value; },
      colocarUsuario,
      setData(data) { DADOS = data; },
      setViewport(width, height) { $("viewport").getBoundingClientRect = () => ({ width, height, left: 0, top: 0 }); },
      setView(value) { view = { ...view, ...value }; },
      getView() { return { ...view }; },
      setRoute(route) { rotaAtual = route; },
      setNavigation(value) { nav = value; },
      atualizaTransform, zoomEm,
      desenharGrafo,
      dijkstra, rotaNoGrafo, planejarRota, tracarRota, limparCamposRota, escolherVoz, configurarEnunciado, atualizarListaVozes, ativarGuiaAoEntrar,
      setVoice(value) { idVozSelecionada = value; $("voice-select").value = value; },
      iniciarTrajeto, cancelarTrajeto, atualizarNavegacao, orientarGiro, pontosDeOrientacao, textoOrientacao, alertasDaRota, falar, falarAlerta,
      getSpeechState() { return { falaAtiva, falaOrientacaoPendente, filaAlertas: filaAlertas.slice() }; }
    };
  `;
  vm.runInNewContext(`${source}\n${bridge}`, sandbox, { filename: "app.js" });
  return {
    api: sandbox.navigationTestApi,
    elements,
    window,
    spoken,
    alerts,
    getCancelCalls: () => cancelCalls,
    getResumeCalls: () => resumeCalls
  };
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

test("visual impairment preference excludes explicitly alternative route edges", () => {
  const { api } = loadNavigation();
  api.setLocations([
    { id: 1, nome: "Bloco A", x: 0, y: 0 },
    { id: 2, nome: "Bloco B", x: 10, y: 0 }
  ]);
  api.setGraph(
    [
      { id: "L1", x: 0, y: 0 },
      { id: "L2", x: 10, y: 0 },
      { id: "N1", x: 2, y: 3 },
      { id: "N2", x: 8, y: 3 }
    ],
    [
      ["L1", "L2", "caminho alternativo"],
      ["L1", "N1", "externo"],
      ["N1", "N2", "externo"],
      ["N2", "L2", "externo"]
    ]
  );

  const unrestricted = api.planejarRota("Bloco A", "Bloco B");
  assert.deepEqual(Array.from(unrestricted.pts, point => point.id), ["L1", "L2"]);

  api.setAvoidAlternatives(true);
  const accessible = api.planejarRota("Bloco A", "Bloco B");
  assert.deepEqual(Array.from(accessible.pts, point => point.id), ["L1", "N1", "N2", "L2"]);
  assert.equal(accessible.pts.some(point => point.tipoAresta === "caminho alternativo"), false);

  api.setGraph(
    [{ id: "L1", x: 0, y: 0 }, { id: "L2", x: 10, y: 0 }],
    [["L1", "L2", "rota alternativa"]]
  );
  assert.equal(api.planejarRota("Bloco A", "Bloco B"), null);
});

test("campus graph tags only the violet segments confirmed on the annotated map", () => {
  const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "caminhos.json"), "utf8"));
  const key = (a, b) => [a, b].sort().join("|");
  const tagged = graph.arestas.filter(edge => {
    const tags = Array.isArray(edge) ? edge[3] : edge.tags;
    return Array.isArray(tags) && tags.includes("alternativo");
  });
  const expected = [
    ["N29", "N30"], ["N30", "N31"], ["N163", "N164"], ["N164", "N165"],
    ["N165", "N166"], ["N166", "N167"], ["N168", "N169"], ["N170", "N162"],
    ["N153", "N224"], ["N241", "N242"], ["N253", "N255"], ["N241", "N375"],
    ["N399", "N400"], ["N402", "N403"], ["N408", "N409"], ["N424", "N425"],
    ["N426", "N427"], ["N427", "N428"], ["N470", "N471"], ["N473", "N467"],
    ["N407", "N487"], ["N488", "N486"], ["N571", "N467"], ["N605", "N604"],
    ["N606", "N607"], ["N607", "N608"], ["N612", "N613"], ["N613", "N614"],
    ["N614", "N586"], ["N587", "N617"], ["N618", "N623"], ["N625", "N624"],
    ["N646", "N774"], ["N652", "N742"], ["N625", "N654"], ["N676", "N674"],
    ["N706", "N467"], ["N742", "N604"], ["N774", "N647"], ["N777", "N605"],
    ["N801", "N5"]
  ];
  assert.deepEqual(tagged.map(edge => key(edge[0], edge[1])).sort(), expected.map(([a, b]) => key(a, b)).sort());
  assert.ok(tagged.every(edge => (Array.isArray(edge) ? edge[2] : edge.tipo) !== "alternativo"));
});

test("real campus locations use the checkbox to avoid violet edges when a detour exists", () => {
  const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "caminhos.json"), "utf8"));
  const alternativeEdges = graph.arestas.filter(edge => {
    const tags = Array.isArray(edge) ? edge[3] : edge.tags;
    return Array.isArray(tags) && tags.includes("alternativo");
  });
  const alternativePairs = new Set(alternativeEdges.map(edge => [edge[0], edge[1]].sort().join("|")));
  const { api } = loadNavigation();
  api.setGraph(graph.nos, graph.arestas);

  const usesAlternative = route => route.slice(1).some((point, index) =>
    alternativePairs.has([route[index].id, point.id].sort().join("|"))
  );
  api.setAvoidAlternatives(false);
  const unrestricted = api.rotaNoGrafo({ id: 5 }, { id: 12 });
  assert.ok(unrestricted);
  assert.ok(usesAlternative(unrestricted), "expected the unfiltered L5-to-L12 route to use a tagged violet edge");

  api.setAvoidAlternatives(true);
  const accessible = api.rotaNoGrafo({ id: 5 }, { id: 12 });
  assert.ok(accessible, "expected the real graph to provide an accessible detour");
  assert.equal(usesAlternative(accessible), false);
});

test("alternative tags preserve a route segment's original category", () => {
  const { api } = loadNavigation();
  api.setGraph(
    [{ id: "A", x: 0, y: 0 }, { id: "B", x: 10, y: 0 }, { id: "C", x: 0, y: 10 }, { id: "D", x: 10, y: 10 }],
    [["A", "B", "interno", ["alternativo"]], ["A", "C", "externo"], ["C", "D", "externo"], ["D", "B", "externo"]]
  );
  const unrestricted = api.dijkstra("A", "B");
  assert.deepEqual(Array.from(unrestricted, point => point.id), ["A", "B"]);
  assert.equal(unrestricted[1].tipoAresta, "interno");
  const accessible = api.dijkstra("A", "B", true);
  assert.deepEqual(Array.from(accessible, point => point.id), ["A", "C", "D", "B"]);
});

test("map offers an unchecked, labeled visual impairment route preference", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<label for="evitar-alternativos">[\s\S]*?<input id="evitar-alternativos" type="checkbox">[\s\S]*?Tenho deficiência visual — evitar caminhos alternativos/);
  assert.match(html, /O filtro evita os trechos identificados como alternativos/);
  assert.doesNotMatch(html, /id="evitar-alternativos"[^>]*checked/);
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

test("voice resumes browser speech and continues the queue after playback errors", () => {
  const { api, spoken, elements, getResumeCalls } = loadNavigation([
    { voiceURI: "pt-br-maria", name: "Maria", lang: "pt-BR" }
  ]);
  api.setVoice("feminina");
  api.falar("Siga em frente por 20 metros.");
  api.falarAlerta("Atenção: travessia à frente.", "crossing-1");

  assert.equal(spoken.length, 1);
  assert.ok(getResumeCalls() > 0);
  assert.equal(api.getSpeechState().falaAtiva, true);
  spoken[0].onerror({ error: "not-allowed" });
  assert.match(elements.get("user-status").textContent, /erro no guia por voz: not-allowed/);
  assert.equal(spoken.length, 2);
  assert.equal(spoken[1].text, "Atenção: travessia à frente.");
  spoken[1].onend();
  assert.equal(api.getSpeechState().falaAtiva, false);
});

test("voice selection only matches the requested gender among Brazilian Portuguese voices", () => {
  const { api } = loadNavigation();
  const voices = [
    { voiceURI: "en", lang: "en-US", default: true },
    { voiceURI: "pt-pt-maria", name: "Maria", lang: "pt-PT", default: false },
    { voiceURI: "pt-br-maria", name: "Maria", lang: "pt-BR", default: false },
    { voiceURI: "pt-br-daniel", name: "Daniel", lang: "pt-BR", default: false }
  ];
  assert.equal(api.escolherVoz(voices, "feminina").voiceURI, "pt-br-maria");
  assert.equal(api.escolherVoz(voices, "masculina").voiceURI, "pt-br-daniel");
  assert.equal(api.escolherVoz(voices.slice(0, 2), "feminina"), null);
  assert.equal(api.escolherVoz(voices, "auto"), null);
});

test("voice settings apply selected native voice and bounded speaking rate", () => {
  const voice = { voiceURI: "pt-br-maria", name: "Maria", lang: "pt-BR" };
  const { api, spoken } = loadNavigation([voice]);
  api.setVoice("feminina");
  api.atualizarListaVozes();
  api.element("voice-rate").value = "1.25";
  api.configurarEnunciado(spoken);
  assert.equal(spoken.lang, "pt-BR");
  assert.equal(spoken.voice, voice);
  assert.equal(spoken.rate, 1.25);
  api.element("voice-rate").value = "0.5";
  api.configurarEnunciado(spoken);
  assert.equal(spoken.rate, 0.75);
});

test("late-loaded voices preserve the requested gender selection", () => {
  const voices = [];
  const { api, elements, window } = loadNavigation(voices);
  api.setVoice("masculina");
  voices.push({ voiceURI: "pt-br-daniel", name: "Daniel", lang: "pt-BR" });

  window.speechSynthesis.onvoiceschanged();
  const utterance = {};
  api.configurarEnunciado(utterance);

  assert.equal(elements.get("voice-select").value, "masculina");
  assert.equal(utterance.voice.voiceURI, "pt-br-daniel");
});

test("missing selected voice falls back to browser synthesis with pt-BR settings", () => {
  const { api, spoken, elements } = loadNavigation([{ voiceURI: "pt-br-generic", name: "Português Brasil", lang: "pt-BR" }]);
  api.setVoice("masculina");
  api.element("voice-rate").value = "1.2";
  api.configurarEnunciado(spoken);
  assert.equal(spoken.voice, null);
  assert.equal(spoken.lang, "pt-BR");
  assert.equal(spoken.rate, 1.2);
  assert.equal(spoken.pitch, 0.8);
  assert.match(elements.get("user-status").textContent, /usando fala sintetizada padrão/);
});

test("voice screen activation speaks with the selected gender when the guide is on", () => {
  const female = { voiceURI: "pt-br-maria", name: "Maria", lang: "pt-BR" };
  const male = { voiceURI: "pt-br-daniel", name: "Daniel", lang: "pt-BR" };
  const { api, spoken, elements } = loadNavigation([female, male]);
  elements.get("toggle-guia-voz").checked = true;
  elements.get("voice-select").value = "masculina";

  api.ativarGuiaAoEntrar();

  assert.equal(elements.get("toggle-guia-voz").checked, true);
  assert.equal(spoken.length, 1);
  assert.match(spoken[0].text, /Guia por voz ativo/);
  assert.equal(spoken[0].voice, male);
});

test("entering the route screen respects a guide the user turned off", () => {
  const { api, spoken, elements } = loadNavigation([{ voiceURI: "pt-br-maria", name: "Maria", lang: "pt-BR" }]);
  elements.get("toggle-guia-voz").checked = false;

  api.ativarGuiaAoEntrar();

  assert.equal(elements.get("toggle-guia-voz").checked, false);
  assert.equal(spoken.length, 0);
});

test("voices that report the language as pt_BR are accepted", () => {
  const female = { voiceURI: "pt-br-maria", name: "Maria", lang: "pt_BR" };
  const { api } = loadNavigation([female]);
  assert.equal(api.escolherVoz([female], "feminina"), female);
});

test("route with the same origin and destination explains the problem", () => {
  const { api, alerts } = loadNavigation();
  api.setLocations([{ id: 1, nome: "Bloco A", tipo: 1, x: 0, y: 0 }]);
  api.setGraph([{ id: "L1", x: 0, y: 0 }], []);
  api.element("origem-input").value = "Bloco A";
  api.element("destino-input").value = "bloco a";
  api.tracarRota();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /mesmo local/);
});

test("avoiding alternative paths explains when a destination needs them", () => {
  const { api, alerts } = loadNavigation();
  api.setLocations([
    { id: 1, nome: "Bloco A", tipo: 1, x: 0, y: 0 },
    { id: 2, nome: "Bloco B", tipo: 1, x: 10, y: 0 }
  ]);
  api.setGraph(
    [{ id: "L1", x: 0, y: 0 }, { id: "L2", x: 10, y: 0 }],
    [["L1", "L2", "externo", ["alternativo"]]]
  );
  api.element("origem-input").value = "Bloco A";
  api.element("destino-input").value = "Bloco B";
  api.setAvoidAlternatives(true);
  api.tracarRota();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /sem trechos alternativos/);

  api.setGraph([{ id: "L1", x: 0, y: 0 }, { id: "L2", x: 10, y: 0 }], []);
  api.tracarRota();
  assert.match(alerts[1], /Não há um caminho mapeado/);
});

test("a nickname such as Anatômico finds the same place as its main name", () => {
  const { api } = loadNavigation();
  api.setLocations([
    { id: 1, nome: "Bloco A", tipo: 1, x: 0, y: 0 },
    { id: 2, nome: "Bloco S", tipo: 1, x: 10, y: 0, apelidos: ["Anatômico"] }
  ]);
  api.setGraph(
    [{ id: "L1", x: 0, y: 0 }, { id: "L2", x: 10, y: 0 }],
    [["L1", "L2", "externo"]]
  );
  const rota = api.planejarRota("Bloco A", "anatomico");
  assert.equal(rota.destino.nome, "Bloco S");
});

test("unsupported speech synthesis reports an accessible error instead of silent success", () => {
  const { api, elements } = loadNavigation([], false);
  api.falar("Siga em frente.");
  assert.match(elements.get("user-status").textContent, /indisponível neste navegador/);
  assert.equal(api.getSpeechState().falaAtiva, false);
});

test("voice controls offer only female and male Brazilian Portuguese options", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const voiceSelector = html.match(/<select id="voice-select"[\s\S]*?<\/select>/)[0];
  assert.match(voiceSelector, /value="feminina">Feminina pt-BR/);
  assert.match(voiceSelector, /value="masculina">Masculina pt-BR/);
  assert.equal((voiceSelector.match(/<option\b/g) || []).length, 2);
  assert.doesNotMatch(voiceSelector, /auto|voiceURI|pt-PT/i);
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

test("map image and route overlay retain the positioning styles needed to render", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(styles, /\.world\s*\{[^}]*position:\s*absolute;[^}]*transform-origin:\s*0 0;/s);
  assert.match(styles, /\.world img\s*\{[^}]*display:\s*block;[^}]*max-width:\s*none;/s);
  assert.match(styles, /\.overlay\s*\{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none;/s);
});

test("map viewport shows only the image and active route, with controls outside it", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  assert.match(html, /<div class="map-controls"[\s\S]*?<\/div>\s*<div id="viewport"/);
  assert.match(html, /id="pins"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(html, /id="me"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(styles, /#pins\s*\{\s*display:\s*block !important;/);
  assert.doesNotMatch(styles, /#me\s*\{[^}]*display:\s*none\s*!important;/);
  assert.doesNotMatch(styles, /\.map-controls\s*\{[^}]*position:\s*absolute;/s);
});

test("user location marker becomes visible and follows updated positions", () => {
  const { api } = loadNavigation();
  const marker = api.element("me");

  api.colocarUsuario({ x: 25, y: 40 });
  assert.equal(marker.hidden, false);
  assert.equal(marker.style.left, "25px");
  assert.equal(marker.style.top, "40px");

  api.colocarUsuario({ x: 60, y: 75 });
  assert.equal(marker.hidden, false);
  assert.equal(marker.style.left, "60px");
  assert.equal(marker.style.top, "75px");
});

test("map pan and zoom cannot expose empty space around the image", () => {
  const { api, elements } = loadNavigation();
  api.setData({ bbox: { largura: 200, altura: 100 } });
  api.setViewport(100, 100);
  api.setView({ s: 0.1, tx: 1000, ty: 1000 });
  api.atualizaTransform();
  let view = api.getView();
  assert.equal(view.s, 1);
  assert.equal(view.tx, 0);
  assert.equal(view.ty, 0);

  api.zoomEm(2);
  api.setView({ tx: 1000, ty: 1000 });
  api.atualizaTransform();
  view = api.getView();
  assert.equal(view.s, 2);
  assert.equal(view.tx, 0);
  assert.equal(view.ty, 0);

  api.setView({ tx: -1000, ty: -1000 });
  api.atualizaTransform();
  view = api.getView();
  assert.equal(view.tx, -300);
  assert.equal(view.ty, -100);
  assert.ok(elements.get("world").style.transform.includes("scale(2)"));
});
