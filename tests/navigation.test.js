const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadNavigation() {
  const spoken = [];
  let cancelCalls = 0;
  const elements = new Map();
  const speechSynthesis = {
    speak(utterance) { spoken.push(utterance); },
    cancel() { cancelCalls++; }
  };
  const element = () => ({
    checked: true,
    value: "externo",
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    dataset: {},
    appendChild() {},
    setAttribute() {},
    click() {}
  });
  const document = {
    querySelectorAll() { return []; },
    querySelector() { return element(); },
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
    Math,
    Date,
    Set,
    Map
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const bridge = `
    globalThis.navigationTestApi = {
      setGraph(nodes, edges) { grafo = { nos: nodes, arestas: edges, seq: 1 }; mpp = 1; },
      dijkstra, orientarGiro, pontosDeOrientacao, textoOrientacao, alertasDaRota, falar, falarAlerta,
      getSpeechState() { return { falaAtiva, falaOrientacaoPendente, filaAlertas: filaAlertas.slice() }; }
    };
  `;
  vm.runInNewContext(`${source}\n${bridge}`, sandbox, { filename: "app.js" });
  return { api: sandbox.navigationTestApi, elements, spoken, getCancelCalls: () => cancelCalls };
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
