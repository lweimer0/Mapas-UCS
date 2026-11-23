/* =====================================================================
   TEACHABLE MACHINE — TensorFlow.js

   Após treinar o modelo no Teachable Machine:
   1. Exporte o projeto como "TensorFlow.js".
   2. Cole aqui o link que termina em "/".
   3. A partir daí, o scanner já usa model.json e metadata.json.

   Arquivos esperados na URL:
   - model.json
   - metadata.json
   ===================================================================== */

(function () {
  "use strict";

  // Cole aqui somente o link "TensorFlow.js" gerado pelo Teachable Machine.
  // Exemplo: "https://teachablemachine.withgoogle.com/models/EXEMPLO/"
  const TEACHABLE_MACHINE_MODEL_URL = "COLOQUE_AQUI_O_LINK_DO_MODELO/";

  let model = null;
  let loading = null;

  function normalizarUrl(url) {
    const value = String(url || "").trim();
    if (!value || value.includes("COLOQUE_AQUI")) return "";
    return value.endsWith("/") ? value : value + "/";
  }

  async function init() {
    const modelUrl = normalizarUrl(TEACHABLE_MACHINE_MODEL_URL);
    if (!modelUrl) return null;
    if (model) return model;
    if (loading) return loading;

    loading = tmImage.load(modelUrl + "model.json", modelUrl + "metadata.json")
      .then((loadedModel) => {
        model = loadedModel;
        return model;
      })
      .finally(() => {
        loading = null;
      });

    return loading;
  }

  async function predict(input) {
    if (!model) await init();
    if (!model) throw new Error("O modelo do Teachable Machine ainda não foi configurado.");
    return model.predict(input);
  }

  window.teachableMachine = Object.freeze({
    init,
    predict,
    isReady: () => model !== null,
    isConfigured: () => Boolean(normalizarUrl(TEACHABLE_MACHINE_MODEL_URL)),
    getModelUrl: () => normalizarUrl(TEACHABLE_MACHINE_MODEL_URL)
  });
})();
