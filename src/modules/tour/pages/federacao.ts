import type { TourStep } from '../tours';

export const steps: TourStep[] = [
  {
    title: 'Modelo federado',
    body: 'Os modelos IFC da obra numa mesma cena, para a análise virtual dos projetos. Quando a obra tem modelos no Orçamento 4D, a tela abre com todos eles; os arquivos enviados no Obra 360 ficam na outra fonte, onde a cena só muda quando você carrega o conjunto.',
  },
  // Fonte "Modelos do Orçamento 4D": os passos abaixo só aparecem com ela aberta (o tour pula alvo fora da tela).
  {
    target: 'federado-fonte',
    title: 'De onde vêm os modelos',
    body: '"Modelos do Orçamento 4D" mostra, de uma vez, todos os modelos que a obra tem no Orçamento 4D, na revisão atual de lá. "Arquivos IFC do Obra 360" mostra os enviados em Arquivos IFC, com escolha de versões e composições salvas.',
  },
  {
    target: 'federado-ajuda',
    title: 'Como funciona',
    body: 'Abre a explicação da tela: de onde vêm os modelos, o que cada painel faz e o que fica guardado só neste navegador.',
  },
  {
    target: 'federado-cena',
    title: 'A cena',
    body: 'Arraste para girar, role para aproximar e arraste com o botão direito para deslocar. Clique numa peça para selecioná-la (fica azul) e ver os dados dela; a câmera passa a girar em torno da peça.',
  },
  {
    target: 'federado-modelos',
    title: 'Modelos: ligar, cor e opacidade',
    body: 'Clique no título para abrir a lista. A caixa de cada disciplina liga e desliga o modelo, o quadrado troca a cor e a barra ajusta a opacidade. Desligada, a disciplina fica como um vulto transparente (ou some, se você marcar a opção no fim da lista) e não pega o clique: dá para selecionar o que está embutido nela. "Resetar" volta tudo ao original.',
  },
  {
    target: 'federado-corte',
    title: 'Caixa de corte',
    body: 'Liga uma caixa alinhada às paredes do prédio que recorta todos os modelos. Ajuste Altura, Comprimento e Largura pelas barras ou arraste as bolinhas nas faces da caixa, direto no 3D. "Ajustar à seleção" fecha a caixa em volta da peça selecionada; "Modelo inteiro" reabre.',
  },
  {
    target: 'federado-medir',
    title: 'Medir',
    body: 'Com a medição ligada, clique em dois pontos do modelo: o ponto encaixa em vértices (verde) e arestas (laranja), senão fica na superfície. A lista mostra a distância e as componentes horizontal e vertical. Esc cancela o primeiro ponto; desligar apaga as medidas.',
  },
  {
    target: 'federado-elemento',
    title: 'Elemento selecionado',
    body: 'Os dados da peça clicada: modelo e arquivo, classe IFC, tipo, pavimento, material e GlobalId. "Quantitativos" traz as medidas do IFC e as calculadas pela geometria; "Propriedades", as propriedades da peça e do tipo. O X limpa a seleção.',
  },
  {
    target: 'federado-recentralizar',
    title: 'Recentralizar',
    body: 'Enquadra todos os modelos visíveis; com a caixa de corte ligada, enquadra a caixa.',
  },
  {
    target: 'federation-help',
    title: 'Como funciona',
    body: 'Abre a explicação da tela: como montar e carregar o conjunto, o que uma composição salva guarda e o que é só exploração (cores, recortes e visibilidade não alteram a composição).',
  },
  {
    target: 'federation-ifc-link',
    title: 'Ir aos arquivos IFC',
    body: 'Abre Arquivos IFC, onde os modelos são cadastrados e as versões enviadas. Só carrega no conjunto a versão que já tem dados e geometria 3D.',
  },
  {
    target: 'federation-saved',
    title: 'Composições salvas',
    body: 'Clique para abrir a área de composições: restaure uma seleção salva ou salve a atual. À direita, o nome da composição aberta ou quantas existem.',
  },
  {
    target: 'federation-saved-open',
    title: 'Abrir uma composição',
    body: 'Restaura os modelos e as versões guardados na composição. A cena só muda quando você carrega o conjunto; versões que não existem mais são avisadas.',
  },
  {
    target: 'federation-saved-save',
    title: 'Salvar a seleção',
    body: 'Dê um nome e salve: cria sempre uma nova cópia com as versões escolhidas agora, fixas mesmo após novos envios de IFC. As composições anteriores são preservadas.',
  },
  {
    target: 'federation-composition',
    title: 'Modelos do conjunto',
    body: 'Monte aqui o conjunto. O contador mostra quantos modelos estão incluídos do total da obra.',
  },
  {
    target: 'federation-search',
    title: 'Buscar modelo',
    body: 'Filtra a lista pelo nome do modelo ou pela disciplina, sem diferenciar acentos.',
  },
  {
    target: 'federation-only-selected',
    title: 'Somente selecionados',
    body: 'Esconde da lista os modelos que estão fora do conjunto.',
  },
  {
    target: 'federation-bulk',
    title: 'Seleção rápida',
    body: 'Selecionar disponíveis inclui cada modelo na versão mais recente que já tem dados e geometria. Limpar seleção tira todos; ao marcar um modelo de novo, ele volta na versão que tinha.',
  },
  {
    target: 'federation-load',
    title: 'Carregar conjunto',
    body: 'O aviso diz quantos modelos estão prontos ou o que falta. O botão só libera quando todos os selecionados têm dados e geometria; depois do primeiro carregamento, ele vira Aplicar seleção ao 3D.',
  },
  {
    target: 'federation-models',
    title: 'Escolher modelos e versões',
    body: 'Marque cada modelo que entra no conjunto e escolha a versão. A linha diz se a versão está pronta para carregar ou se faltam dados ou geometria. Se a busca esconder todos, Limpar filtros mostra a lista de novo.',
  },
  {
    target: 'federation-viewer',
    title: 'Explorar o conjunto',
    body: 'A cena com os modelos carregados. O selo no canto mostra o estado: aguardando seleção, carregando, conjunto carregado ou falha.',
  },
  {
    target: 'federation-paint',
    title: 'Cores',
    body: 'Pinta a cena por modelo, por pavimento ou por classe IFC. Por modelo, cada disciplina tem uma cor fixa, a mesma em qualquer versão ou composição.',
  },
  {
    target: 'federation-storey',
    title: 'Pavimento',
    body: 'Mostra só o pavimento escolhido, em todos os modelos do conjunto.',
  },
  {
    target: 'federation-view-buttons',
    title: 'Enquadrar e mostrar tudo',
    body: 'Enquadrar ajusta a câmera para caberem todos os modelos carregados. Mostrar tudo reexibe os modelos ocultos e desfaz o pavimento, o corte e a seleção.',
  },
  {
    target: 'federation-section',
    title: 'Seccionamento',
    body: 'Ative o corte, escolha a orientação (horizontal Y, vertical X ou Z) e ajuste a posição de 0 a 100%. O mesmo plano atravessa todos os modelos; Inverter lado troca a metade visível e Remover corte desfaz.',
  },
  {
    target: 'federation-canvas',
    title: 'Cena 3D',
    body: 'Arraste para orbitar, role para aproximar e clique numa peça para selecioná-la; ela fica em âmbar. O clique ignora o que está além do plano de corte.',
  },
  {
    target: 'federation-clip-bar',
    title: 'Recorte ativo',
    body: 'Lembra o que está escondendo parte do conjunto: modelos ocultos, pavimento ou corte. Limpar recorte desfaz tudo de uma vez.',
  },
  {
    target: 'federation-explorer',
    title: 'Modelos ou elementos',
    body: 'Alterna o painel abaixo da cena entre a lista de modelos em cena e a busca de elementos. Ocultar, isolar e colorir não alteram a composição salva.',
  },
  {
    target: 'federation-scene-models',
    title: 'Modelos em cena',
    body: 'Em cada modelo: o olho oculta ou mostra, a paleta abre a cor e a opacidade dele, e Isolar esconde todos os outros.',
  },
  {
    target: 'federation-appearance',
    title: 'Cor e opacidade',
    body: 'Escolha a cor padrão, a cor do IFC ou uma cor própria, e a opacidade de 10% a 100%. A cor vale na pintura por modelo; a opacidade, em qualquer pintura. Fica lembrada neste navegador; Voltar ao padrão desfaz.',
  },
  {
    target: 'federation-element-search',
    title: 'Buscar elementos',
    body: 'Procure por nome, classe IFC ou GlobalId nos modelos e pavimentos visíveis; aparecem os 50 primeiros resultados. Clique num resultado para selecioná-lo no 3D.',
  },
  {
    target: 'federation-picked',
    title: 'Elemento selecionado',
    body: 'Mostra modelo e versão, classe IFC, pavimento e GlobalId da peça escolhida no 3D ou na busca. O X limpa a seleção.',
  },
  {
    target: 'federation-legend',
    title: 'Legenda do conjunto',
    body: 'Com a pintura por pavimento ou por classe IFC, abra para ver a cor de cada grupo e quantos elementos ele tem no conjunto todo.',
  },
];
