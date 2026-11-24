import type { TourStep } from '../tours';

/** Tour da aba 2.4, Diário de Obra (24/11/2026). Os alvos ficam na tela do diário (`src/modules/diario/`),
 * que serve também ao modo de campo (`/campo/diario`). São cinco, de propósito: o cabeçalho com a obra, a
 * data e a situação; o clima e a jornada; a mão de obra; as fotos; e o botão de envio. Passo com alvo fora
 * da tela (papel consulta sem o botão de envio, por exemplo) é pulado sozinho. */
export const steps: TourStep[] = [
  {
    title: 'Aba 2.4 · Diário de Obra',
    body: 'O diário do dia, preenchido aqui e enviado ao Sienge por botão: clima e jornada por turno, índice pluviométrico, atividades, mão de obra, equipamentos, ocorrências, observações e fotos. Existe um diário por obra e dia, e nada sai para o Sienge sozinho.',
  },
  {
    target: 'diario-dia',
    title: 'Dia e situação',
    body: 'Escolha a data do diário. A etiqueta mostra se ele está em rascunho ou se já foi enviado ao Sienge, com o número que recebeu lá. O responsável é o seu código de usuário do Sienge, informado uma vez e guardado no seu cadastro.',
  },
  {
    target: 'diario-turnos',
    title: 'Clima e jornada',
    body: 'Ligue os turnos trabalhados (manhã, tarde, noite) e informe início, fim e clima de cada um; o índice pluviométrico, em milímetros, fica ao lado. Pelo menos um turno é obrigatório para o Sienge aceitar o diário.',
  },
  {
    target: 'diario-mao-de-obra',
    title: 'Mão de obra',
    body: 'É o histograma do dia: as mesmas linhas da aba 2.2, por empresa e função. O que você lança aqui aparece lá, e o que já foi lançado lá vem pronto. "Repetir o último dia" copia as equipes do último dia lançado. Ao Sienge a mão de obra vai por empresa, somando as funções.',
  },
  {
    target: 'diario-fotos',
    title: 'Fotos',
    body: 'Cada foto leva descrição e local. Foto sem local, ou com local ainda não ligado ao local do Sienge, sobe para o diário mas não entra no Relatório Fotográfico do Sienge. Foto nova pode entrar mesmo depois do envio.',
  },
  {
    target: 'diario-enviar',
    title: 'Enviar ao Sienge',
    body: 'No fim do dia, este botão cria o diário no Sienge e manda as fotos, uma de cada vez. Depois de enviado, o diário fica travado: para corrigir, um administrador exclui do Sienge e reabre. Sem sinal o rascunho fica guardado no aparelho, e o envio espera a conexão e o seu clique.',
  },
];
