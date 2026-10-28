# Mapas-UCS
Trabalho da disciplina de Ciência Tecnologia Inovação e Sociedade da Universidade de Caxias do Sul

## Mapa e orientação acessível

O mapa ilustrado (`mapa-campus.jpg`) permanece como base visual de referência; os caminhos são desenhados por cima a partir de `caminhos.json`. A legenda usa as categorias externo, interno, escadaria, rampa, rua/travessia, alternativo e ligação. No editor (ícone de lápis), selecione a categoria antes de criar trechos; caminhos já classificados como travessia ou local de atenção continuam identificados e geram avisos. O grafo atual ainda não contém trechos classificados como escadaria, rampa ou alternativo: eles precisam ser identificados no editor antes de aparecerem na rota ou acionarem alertas.

Com o guia por voz ativado, as instruções usam movimento relativo (“Siga em frente”, “Vire à esquerda/direita”), informam a distância até a próxima mudança e repetem a orientação a cada dez segundos enquanto a localização é atualizada. Alertas de travessia, escadaria, rampa e locais marcados para atenção entram na fila de fala sem interromper a orientação em andamento. O guia começa ativado e pode ser desligado na tela da rota.

**Limite de precisão:** a imagem ajuda a identificar o traçado geral, mas não permite confirmar coordenadas exatas, inclinações, a posição precisa de escadarias/rampas nem as condições atuais das travessias. Os alertas desses tipos só podem ser emitidos quando o trecho correspondente estiver classificado no grafo. Se não existir caminho conectado no grafo, o app não oferece navegação por linha reta. Distâncias e posição também dependem da escala estimada do mapa e da precisão do GPS; confirme travessias no local e não use a rota como substituto de sinalização ou assistência presencial.

Os testes de navegação podem ser executados com `node --test tests/navigation.test.js`.
