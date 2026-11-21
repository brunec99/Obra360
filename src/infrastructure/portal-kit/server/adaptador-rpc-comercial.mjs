// @ts-self-types="./adaptador-rpc-comercial.d.mts"
// @atr/portal-kit · server/adaptador-rpc-comercial.mjs
// Adaptador de perfil por RPC: Portal Comercial (comercial), schema `comercial`.
//
// Regras (iguais ao comercial-login atual):
// - Busca da conta por `comercial.usuario_por_email(p_email)` → uuid (também na nova busca
//   depois de corrida no createUser). Erro lança → 503.
// - Conta nova SEM senha (como hoje). `app_metadata.origem` NÃO é fixo aqui: vem do
//   `aoCriarConta` do app (o handle_new_user do BI, no mesmo projeto, depende dessa marca).
// - `comercial.entrada_portal(p_user, p_email, p_nome)` faz tudo (cria/libera pendente,
//   respeita bloqueio, nunca mexe em papel — D14: a re-liberação fica na RPC).
//   Lista de PERMISSÃO (ME-03): só 'liberado' entra; 'bloqueado' → 403; qualquer outro valor
//   (estado novo numa migração futura, erro de digitação) → 503. Erro ou lista vazia → 503.
//   Valores conferidos na migração 0011 do Comercial (07/11/2026): 'liberado' e 'bloqueado'.
//
// v0.3.0 — o adaptador passa a ENTENDER a situação 'pendente' (a RPC ainda não a devolve; isso é da
// virada do Comercial). Uma opção, com padrão fechado:
// - `sessaoParaPendente` (padrão `false`): 'pendente' → 403 `acesso_bloqueado`, sem magic link, como o
//   bloqueado. Só `true` dá sessão ao pendente (o app mostra a tela de "aguardando aprovação"), com o
//   papel que a RPC devolveu. Enquanto a RPC só devolver 'liberado' e 'bloqueado', nada muda.
// - Situação que o adaptador não conhece continua 503 (falha fechada), com ou sem a opção.
// NÃO há `aprovaNoPrimeiroAcesso` nem `preAprovacao` aqui, de propósito: no Comercial a regra INTEIRA
// mora na RPC do banco (quem nasce pendente, quem entra aprovado por convite, pedido ou carga, com que
// papel, e deixar de reaprovar quem já existe). O adaptador recebe a conta só com `id` e `email` (sem
// `app_metadata` nem `created_at`) e não passa o `portal_role` do token à RPC: nenhum papel do
// Comercial deriva de admin do Portal por este caminho.
// ATENÇÃO: com `sessaoParaPendente: true` o pendente tem sessão; isso só é seguro se as policies e
// funções do Comercial exigirem a aprovação JUNTO com o papel. O kit não confere as policies do app.

/**
 * `semPerfilEmContaExistente` não tem efeito aqui (LO-03): a RPC `entrada_portal` cria o perfil de
 * quem não tem, então `ler` sempre devolve `existe: true`. Fica aceito só por compatibilidade.
 * @param {{
 *   schema?: string,
 *   esperarGatilhoMs?: number,
 *   semPerfilEmContaExistente?: 'criar' | 'recusar',
 *   sessaoParaPendente?: boolean,   // v0.3.0; padrão false (pendente → 403)
 * }} [opcoes]
 */
export function rpcComercial({ schema = 'comercial', esperarGatilhoMs = 0, semPerfilEmContaExistente = 'criar', sessaoParaPendente = false } = {}) {
  // Só `true` abre sessão para o pendente: "sim", 1 ou outro valor verdadeiro ficam no padrão fechado.
  const pendenteComSessao = sessaoParaPendente === true
  return {
    tipo: 'rpcComercial',
    schema,
    esperarGatilhoMs,
    semPerfilEmContaExistente,
    // O contrato lê (caso rpc_pendente).
    sessaoParaPendente: pendenteComSessao,
    papelInicial: () => null, // não usado: o papel é da RPC

    async acharUsuario(admin, email) {
      const { data, error } = await admin.schema(schema).rpc('usuario_por_email', { p_email: email })
      if (error) throw error
      return data ? { id: data, email } : undefined
    },

    contaNova: (ctx) => ({ user_metadata: { full_name: ctx.nome } }),

    async ler(admin, usuario, ctx) {
      const { data, error } = await admin.schema(schema).rpc('entrada_portal', {
        p_user: usuario.id, p_email: ctx.email, p_nome: ctx.nome,
      })
      if (error) throw error
      const linha = Array.isArray(data) ? data[0] : undefined
      if (!linha) throw new Error('entrada_portal sem linha')
      if (linha.situacao === 'bloqueado') return { existe: true, bloqueado: true, papelLocal: linha.papel ?? null }
      // v0.3.0: pendente é barrado por padrão; com `sessaoParaPendente: true` segue com sessão e o papel da RPC.
      if (linha.situacao === 'pendente') return { existe: true, bloqueado: !pendenteComSessao, papelLocal: linha.papel ?? null }
      // Falha fechada: o que não é 'liberado' explícito não abre sessão (o receptor responde 503).
      if (linha.situacao !== 'liberado') throw new Error(`entrada_portal: situação desconhecida ${JSON.stringify(linha.situacao)}`)
      return { existe: true, bloqueado: false, papelLocal: linha.papel ?? null }
    },

    // A RPC de `ler` já gravou tudo; aqui só devolve o papel.
    async primeiroAcesso(_admin, _usuario, ctx) {
      return ctx.papelLocal
    },
  }
}
