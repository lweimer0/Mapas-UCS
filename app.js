/* =====================================================================
   TRILHAS UCS — app.js
   Procure por "COLOQUE AQUI" para achar todos os lugares que precisam
   de chave de API / configuração antes de rodar de verdade.
   ===================================================================== */

/* =====================================================================
   1) CONFIGURAÇÃO — chaves e IDs
   ===================================================================== */

// --- Mapbox (mapa + cálculo de rota a pé) ---
// Crie uma conta grátis em https://account.mapbox.com/ e copie o token
// "Default public token" (começa com "pk.").
const MAPBOX_TOKEN = "pk.eyJ1IjoibHdlaW1lcjAiLCJhIjoiY212aWdzYWFlMDV5YjJ3b3I1aXVqZzRzeSJ9.EpqPvotNMPWEYF5YPBVI8A"; // <- COLOQUE AQUI

// --- Firebase (salvar quais figurinhas o usuário já desbloqueou) ---
// Crie um projeto em https://console.firebase.google.com/ , ative
// "Firestore Database" e "Authentication > Anônimo", depois copie o
// objeto de configuração em Configurações do projeto > Seus apps.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBu8dt-WUaYIIFxangfUWJfbqu0s-kDph0",            // <- COLOQUE AQUI
  authDomain: "mapaucs-ed75b.firebaseapp.com",
  projectId: "mapaucs-ed75b",
  storageBucket: "mapaucs-ed75b.firebasestorage.app",
  messagingSenderId: "58460944522",
  appId: "1:58460944522:web:43a49bfa22486bd04c5573"
};

// --- Teachable Machine (reconhecimento das obras de arte) ---
// Treine o modelo em https://teachablemachine.withgoogle.com/ (projeto
// de Imagem), clique em "Export Model > Upload my model" e cole o link
// que ele gera (termina em "/").
const TEACHABLE_MACHINE_MODEL_URL = "COLOQUE_AQUI_O_LINK_DO_MODELO/"; // <- COLOQUE AQU

/* =====================================================================
   2) ESTADO GLOBAL
   ===================================================================== */

let map;                 // instância do mapa Mapbox
let userMarker;          // marcador da posição do usuário
let watchId;             // id do navigator.geolocation.watchPosition
let tmModel, tmMaxPredictions; // modelo do Teachable Machine carregado
let db;                  // referência do Firestore

// Grafo de pontos do campus (nós + conexões).
// Substitua pelas coordenadas reais da UCS. Cada nó é um ponto de
// interesse (entrada de bloco, cruzamento de calçada, etc).
// formato: nome -> { lat, lng, vizinhos: { nomeDoVizinho: distanciaEmMetros } }
const CAMPUS_GRAFO = {
  "Bloco A":      { lat: -29.1680, lng: -51.1800, vizinhos: { "Cruzamento 1": 40 } },
  "Cruzamento 1": { lat: -29.1682, lng: -51.1795, vizinhos: { "Bloco A": 40, "Bloco B": 60, "Biblioteca": 90 } },
  "Bloco B":      { lat: -29.1685, lng: -51.1790, vizinhos: { "Cruzamento 1": 60 } },
  "Biblioteca":   { lat: -29.1690, lng: -51.1805, vizinhos: { "Cruzamento 1": 90 } }
};

// Lista de obras de arte do campus, na mesma ordem das classes
// treinadas no Teachable Machine. O "label" tem que bater com o nome
// da classe que você deu ao treinar o modelo.
const OBRAS_DE_ARTE = [
  { label: "escultura-sol", nome: "Escultura do Sol", artista: "Fulano de Tal", descricao: "Instalação em aço inox, 1998." },
  { label: "mural-entrada", nome: "Mural da Entrada", artista: "Ciclana", descricao: "Mural pintado em 2005, tema regional." }
  // adicione aqui as outras obras, uma por classe treinada
];

/* =====================================================================
   3) NAVEGAÇÃO ENTRE TELAS (tab bar)
   ===================================================================== */

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => mostrarTela(btn.dataset.screen));
});

function mostrarTela(nome) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`screen-${nome}`).classList.add("active");
  document.querySelector(`.tab-btn[data-screen="${nome}"]`).classList.add("active");

  if (nome === "scanner") iniciarCamera();
  else pararCamera();
}

/* =====================================================================
   4) MAPA + GEOLOCALIZAÇÃO (Mapbox + Geolocation API)
   ===================================================================== */

function iniciarMapa() {
  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: "mapa",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-51.1800, -29.1680], // [lng, lat] aproximado do campus — ajuste
    zoom: 17
  });

  // Marca os nós do grafo no mapa (opcional, útil pra depurar)
  Object.entries(CAMPUS_GRAFO).forEach(([nomeNo, no]) => {
    new mapboxgl.Marker({ color: "#4c7a5a" })
      .setLngLat([no.lng, no.lat])
      .setPopup(new mapboxgl.Popup().setText(nomeNo))
      .addTo(map);
  });

  iniciarGeolocalizacao();
}

function iniciarGeolocalizacao() {
  if (!("geolocation" in navigator)) {
    document.getElementById("user-status").textContent = "geolocalização não suportada";
    return;
  }

  // watchPosition chama o callback toda vez que a posição muda —
  // é isso que faz o app "acompanhar" o usuário, igual ao Google Maps.
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      document.getElementById("user-status").textContent = "localização ativa";

      if (!userMarker) {
        userMarker = new mapboxgl.Marker({ color: "#e63946" })
          .setLngLat([longitude, latitude])
          .addTo(map);
      } else {
        userMarker.setLngLat([longitude, latitude]);
      }
    },
    (err) => {
      console.warn("Erro de geolocalização:", err);
      document.getElementById("user-status").textContent = "permissão de localização negada";
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

/* --- Cálculo de rota mais curta entre dois nós (algoritmo de Dijkstra) --- */
function calcularRotaMaisCurta(origem, destino) {
  const distancias = {};
  const anteriores = {};
  const visitados = new Set();
  const naoVisitados = new Set(Object.keys(CAMPUS_GRAFO));

  Object.keys(CAMPUS_GRAFO).forEach(no => (distancias[no] = Infinity));
  distancias[origem] = 0;

  while (naoVisitados.size > 0) {
    // pega o nó não visitado com menor distância conhecida
    let atual = [...naoVisitados].reduce((a, b) => (distancias[a] < distancias[b] ? a : b));
    naoVisitados.delete(atual);
    visitados.add(atual);

    if (atual === destino) break;

    const vizinhos = CAMPUS_GRAFO[atual].vizinhos;
    for (const vizinho in vizinhos) {
      if (visitados.has(vizinho)) continue;
      const novaDistancia = distancias[atual] + vizinhos[vizinho];
      if (novaDistancia < distancias[vizinho]) {
        distancias[vizinho] = novaDistancia;
        anteriores[vizinho] = atual;
      }
    }
  }

  // reconstrói o caminho percorrendo "anteriores" de trás pra frente
  const caminho = [];
  let passo = destino;
  while (passo) {
    caminho.unshift(passo);
    passo = anteriores[passo];
  }

  return { caminho, distanciaTotal: distancias[destino] };
}

document.getElementById("btn-buscar-rota").addEventListener("click", () => {
  const destinoTexto = document.getElementById("destino-input").value.trim();
  if (!CAMPUS_GRAFO[destinoTexto]) {
    alert("Destino não encontrado no grafo do campus. Use um dos nomes cadastrados.");
    return;
  }

  // origem fixa só de exemplo — na versão real, use o nó mais próximo
  // da posição atual do usuário (userMarker.getLngLat())
  const origem = "Bloco A";
  const { caminho, distanciaTotal } = calcularRotaMaisCurta(origem, destinoTexto);

  document.getElementById("rota-info").hidden = false;
  document.getElementById("rota-distancia").textContent = `${distanciaTotal} m`;
  document.getElementById("rota-tempo").textContent = `${Math.ceil(distanciaTotal / 80)} min a pé`;

  desenharRotaNoMapa(caminho);
});

function desenharRotaNoMapa(caminho) {
  const coordenadas = caminho.map(nome => [CAMPUS_GRAFO[nome].lng, CAMPUS_GRAFO[nome].lat]);

  if (map.getSource("rota-linha")) {
    map.getSource("rota-linha").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coordenadas }
    });
  } else {
    map.addSource("rota-linha", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: coordenadas } }
    });
    map.addLayer({
      id: "rota-linha-layer",
      type: "line",
      source: "rota-linha",
      paint: { "line-color": "#2a6f97", "line-width": 4, "line-dasharray": [2, 1] }
    });
  }
}

document.getElementById("btn-iniciar-trajeto").addEventListener("click", () => {
  mostrarTela("rota");
});

document.getElementById("btn-cancelar-trajeto").addEventListener("click", () => {
  mostrarTela("mapa");
});

/* =====================================================================
   5) GUIA POR VOZ (acessibilidade — Web Speech API, sem chave nenhuma)
   ===================================================================== */

document.getElementById("toggle-guia-voz").addEventListener("change", (e) => {
  if (e.target.checked) falar("Guia por voz ativado. Siga em frente por quarenta metros.");
});

function falar(texto) {
  if (!("speechSynthesis" in window)) return;
  const utter = new SpeechSynthesisUtterance(texto);
  utter.lang = "pt-BR";
  window.speechSynthesis.speak(utter);
}

/* =====================================================================
   6) ÁLBUM DE FIGURINHAS + FIREBASE
   ===================================================================== */

function iniciarFirebase() {
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();

  // login anônimo — cada celular vira um "usuário" sem precisar de cadastro
  firebase.auth().signInAnonymously().catch((err) => {
    console.warn("Erro ao autenticar no Firebase:", err);
  });

  firebase.auth().onAuthStateChanged((user) => {
    if (user) carregarAlbum(user.uid);
  });
}

async function carregarAlbum(uid) {
  const doc = await db.collection("usuarios").doc(uid).get();
  const desbloqueadas = doc.exists ? (doc.data().figurinhas || []) : [];
  renderizarAlbum(desbloqueadas);
}

async function desbloquearFigurinha(label) {
  const uid = firebase.auth().currentUser?.uid;
  if (!uid) return;

  const ref = db.collection("usuarios").doc(uid);
  await ref.set(
    { figurinhas: firebase.firestore.FieldValue.arrayUnion(label) },
    { merge: true }
  );

  const doc = await ref.get();
  renderizarAlbum(doc.data().figurinhas || []);
}

function renderizarAlbum(desbloqueadas) {
  const grid = document.getElementById("album-grid");
  grid.innerHTML = "";

  OBRAS_DE_ARTE.forEach((obra) => {
    const unlocked = desbloqueadas.includes(obra.label);
    const div = document.createElement("div");
    div.className = `sticker ${unlocked ? "unlocked" : "locked"}`;
    div.textContent = unlocked ? obra.nome : "?";
    grid.appendChild(div);
  });

  document.getElementById("album-progresso").textContent =
    `${desbloqueadas.length}/${OBRAS_DE_ARTE.length} desbloqueadas`;
}

/* =====================================================================
   7) SCANNER — câmera + Teachable Machine (TensorFlow.js)
   ===================================================================== */

async function carregarModeloTeachableMachine() {
  const modelURL = TEACHABLE_MACHINE_MODEL_URL + "model.json";
  const metadataURL = TEACHABLE_MACHINE_MODEL_URL + "metadata.json";

  tmModel = await tmImage.load(modelURL, metadataURL);
  tmMaxPredictions = tmModel.getTotalClasses();
}

async function iniciarCamera() {
  const video = document.getElementById("scanner-video");
  if (video.srcObject) return; // já está ligada

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
  } catch (err) {
    document.getElementById("scanner-resultado").textContent =
      "Não foi possível acessar a câmera. Verifique a permissão.";
  }
}

function pararCamera() {
  const video = document.getElementById("scanner-video");
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
}

document.getElementById("btn-escanear").addEventListener("click", async () => {
  if (!tmModel) {
    document.getElementById("scanner-resultado").textContent = "Modelo ainda carregando…";
    return;
  }

  const video = document.getElementById("scanner-video");
  const canvas = document.getElementById("scanner-canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);

  const predicoes = await tmModel.predict(canvas);
  // pega a classe com maior probabilidade
  const melhor = predicoes.reduce((a, b) => (a.probability > b.probability ? a : b));

  if (melhor.probability > 0.8) {
    const obra = OBRAS_DE_ARTE.find(o => o.label === melhor.className);
    if (obra) {
      document.getElementById("scanner-resultado").textContent =
        `Reconhecida: ${obra.nome} — ${obra.artista}. ${obra.descricao}`;
      await desbloquearFigurinha(obra.label);
      falar(`Você desbloqueou a figurinha ${obra.nome}`);
    }
  } else {
    document.getElementById("scanner-resultado").textContent =
      "Não reconheci essa obra, tente chegar mais perto ou melhorar a iluminação.";
  }
});

/* =====================================================================
   8) INICIALIZAÇÃO GERAL
   ===================================================================== */

window.addEventListener("DOMContentLoaded", () => {
  iniciarMapa();
  iniciarFirebase();
  carregarModeloTeachableMachine();
});