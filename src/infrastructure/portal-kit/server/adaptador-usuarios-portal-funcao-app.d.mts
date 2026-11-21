// Tipos de server/adaptador-usuarios-portal-funcao-app.mjs (@atr/portal-kit), escritos à mão, sem dependência.

import type { PayloadPortal } from '../core/ssoV2.d.mts'
import type { PreAprovacao } from './pre-aprovacao.d.mts'
import type { AdaptadorPerfil, ClienteAdmin, ContextoPerfil, UsuarioAuth } from './receptor.d.mts'

/** O que o 1º acesso concede: UMA linha em `<schemaFuncao>.<tabelaFuncao>`. */
export interface FuncaoPorApp {
  app: string
  funcao: string
}

export interface OpcoesUsuariosPortalFuncaoApp {
  /** Régua do app (obrigatória): o que o token concede no 1º acesso; `null` = nada. Só vale em conta criada naquele acesso (v0.4.1: ou no acesso seguinte, com `funcaoNoAcessoSeguinte`). */
  funcaoConcedida: (payload: PayloadPortal) => FuncaoPorApp | null
  /** Régua do app (obrigatória): o `role` do perfil no 1º acesso; `null` = a coluna não é gravada. */
  papelPerfil: (payload: PayloadPortal) => string | null
  /** Padrão 'auditor'. */
  schemaPerfil?: string
  /** Padrão 'usuarios_portal'. */
  tabelaPerfil?: string
  /** Padrão 'shared'. */
  schemaFuncao?: string
  /** Padrão 'funcao_app'. */
  tabelaFuncao?: string
  /** Padrão 500 (o gatilho do banco cria o perfil junto com a conta). */
  esperarGatilhoMs?: number
  /** Padrão 'criar'. */
  semPerfilEmContaExistente?: 'criar' | 'recusar'
  /** Padrão false: bloqueado e pendente recebem sessão e o app mostra a tela. true: `status_aprovacao = 'bloqueado'` → 403. */
  barrarBloqueado?: boolean
  /**
   * v0.3.0: o 1º acesso aprova? Só `true` aprova. Padrão `() => true` (como na v0.2.5).
   * Com falso e sem pré-aprovação, o perfil nasce pendente (o update não leva `status_aprovacao`; o
   * insert leva 'pendente') e, se a conta nasceu agora e o token concede alguma função, a função
   * gravada é a que a régua dá a um usuário COMUM — nunca a de admin, mesmo para admin do Portal.
   */
  aprovaNoPrimeiroAcesso?: (payload: PayloadPortal) => boolean
  /**
   * v0.3.0: leitor e marcador da pré-aprovação (`criarPreAprovacao`). Com linha válida para o slug do
   * token, o perfil nasce aprovado e a conta recebe a função que a régua dá a um usuário comum no app do
   * slug (nunca a de admin). Padrão `null` (como na v0.2.5). Com ela declarada, o adaptador ganha
   * `atualizarIdentidade`, que só age na segunda tentativa de um 1º acesso (perfil ainda pendente).
   */
  preAprovacao?: PreAprovacao | null
  /**
   * v0.3.0: coluna do perfil que guarda o app pelo qual a pessoa chegou (no Hub: 'app_origem'). Gravada
   * só em quem nasce PENDENTE. É rótulo de origem: não concede acesso. Padrão `null`. Exige `appDeOrigem`.
   */
  colunaAppOrigem?: string | null
  /** v0.3.0: o app de origem para o token (ex.: 'sst'); `null` = não grava. Padrão `() => null`. Exige `colunaAppOrigem`. */
  appDeOrigem?: (payload: PayloadPortal) => string | null
  /**
   * v0.4.1: a função no app também no ACESSO SEGUINTE. Padrão `null` (como na v0.4.0: a função só nasce
   * com a conta). Com ela, em conta que já existia, se a régua dá função ao token e a conta não tem linha
   * naquele app, o adaptador pergunta ao app e grava UMA linha (upsert que não reescreve) só se a resposta
   * for `true`. A função gravada é SEMPRE a de usuário comum (teto: nunca admin, nem para admin do Portal).
   * No Hub: `false` quando a pessoa tem marca de removida daquele app. Perfil bloqueado nunca grava (nem
   * pergunta). Erro LANÇA (503 sem magic link).
   * Com ela declarada, o adaptador ganha `atualizarIdentidade`.
   */
  funcaoNoAcessoSeguinte?: FuncaoNoAcessoSeguinte | null
}

/** v0.4.1: o app decide se a conta pode ganhar a função no app no acesso seguinte (só `true` grava). */
export type FuncaoNoAcessoSeguinte = (admin: ClienteAdmin, usuarioId: string, app: string) => Promise<boolean>

/** O adaptador do Hub SEM pré-aprovação: `AdaptadorPerfil` sem `atualizarIdentidade`, com o que o contrato lê. */
export interface AdaptadorUsuariosPortalFuncaoApp extends AdaptadorPerfil {
  tipo: 'usuariosPortalFuncaoApp'
  schema: string
  tabela: string
  schemaFuncao: string
  tabelaFuncao: string
  /** O contrato usa: com false, os casos `bloqueado` e `admin_bloqueado` não se aplicam. */
  barrarBloqueado: boolean
  /** O contrato usa: a aprovação do 1º acesso é conferida contra `aprovacaoEsperada`. */
  aprovaNoPrimeiroAcesso: (payload: PayloadPortal) => boolean
  /** O contrato usa: com `null`, os casos `pre_aprovacao_*` não se aplicam. */
  preAprovacao: PreAprovacao | null
  /** O contrato usa: com a coluna declarada, o perfil pendente tem de levar o app de origem. */
  colunaAppOrigem: string | null
  /** O contrato usa (como `papelInicial`). */
  appDeOrigem: (payload: PayloadPortal) => string | null
  atualizarIdentidade?: undefined
}

/** O adaptador do Hub COM pré-aprovação: ganha `atualizarIdentidade`, que só age na segunda tentativa. */
export interface AdaptadorUsuariosPortalFuncaoAppComPre extends Omit<AdaptadorUsuariosPortalFuncaoApp, 'atualizarIdentidade' | 'preAprovacao'> {
  preAprovacao: PreAprovacao
  /** Só grava quando `ler` achou perfil pendente com pré-aprovação válida; fora disso não grava nada. */
  atualizarIdentidade: (admin: ClienteAdmin, usuario: UsuarioAuth, ctx: ContextoPerfil) => Promise<void>
}

/** v0.4.1: o adaptador do Hub COM `funcaoNoAcessoSeguinte` (com ou sem pré-aprovação): ganha `atualizarIdentidade`. */
export interface AdaptadorUsuariosPortalFuncaoAppComAcessoSeguinte extends Omit<AdaptadorUsuariosPortalFuncaoApp, 'atualizarIdentidade'> {
  /** Segunda tentativa da pré-aprovação (quando há), senão a regra do acesso seguinte. */
  atualizarIdentidade: (admin: ClienteAdmin, usuario: UsuarioAuth, ctx: ContextoPerfil) => Promise<void>
}

/** Adaptador para auditor.usuarios_portal + shared.funcao_app: Hub de Engenharia (5 slugs). */
export function usuariosPortalFuncaoApp(
  opcoes: OpcoesUsuariosPortalFuncaoApp & { funcaoNoAcessoSeguinte: FuncaoNoAcessoSeguinte },
): AdaptadorUsuariosPortalFuncaoAppComAcessoSeguinte
export function usuariosPortalFuncaoApp(
  opcoes: OpcoesUsuariosPortalFuncaoApp & { preAprovacao: PreAprovacao },
): AdaptadorUsuariosPortalFuncaoAppComPre
export function usuariosPortalFuncaoApp(opcoes: OpcoesUsuariosPortalFuncaoApp): AdaptadorUsuariosPortalFuncaoApp
