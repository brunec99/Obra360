// Tipos de server/adaptador-profiles-is-admin.mjs (@atr/portal-kit), escritos à mão, sem dependência.

import type { PayloadPortal } from '../core/ssoV2.d.mts'
import type { PreAprovacao } from './pre-aprovacao.d.mts'
import type { AdaptadorPerfil } from './receptor.d.mts'

export interface OpcoesProfilesIsAdmin {
  /** Padrão: portal_role 'admin' → 'admin', senão 'operator'. */
  papelInicial?: (payload: PayloadPortal) => string
  /** Padrão 'criar'. */
  semPerfilEmContaExistente?: 'criar' | 'recusar'
  /** Padrão 500. */
  esperarGatilhoMs?: number
  /** Padrão 'admin_role'. */
  campoPapelResposta?: string
  /**
   * v0.3.0: o 1º acesso grava `is_admin: true`? Só `true` grava. Padrão `() => true` (como na v0.2.5).
   * Com falso e sem pré-aprovação, o 1º acesso grava só o nome: `is_admin` fica falso, a resposta sai
   * com papel `null` e o painel mostra a tela de pendente.
   */
  aprovaNoPrimeiroAcesso?: (payload: PayloadPortal) => boolean
  /**
   * v0.3.0: leitor e marcador da pré-aprovação (`criarPreAprovacao`). Com linha válida, o perfil vira
   * `is_admin` no papel da linha, também em conta EXISTENTE com `is_admin` falso (a conta do aceite,
   * declarada em `marcaExtra` do leitor). Perfil com `is_admin` verdadeiro nunca é tocado.
   * Padrão `null` (como na v0.2.5).
   */
  preAprovacao?: PreAprovacao | null
}

/** O adaptador do painel GLOBAL: `AdaptadorPerfil` com o que o contrato lê. */
export interface AdaptadorProfilesIsAdmin extends AdaptadorPerfil {
  tipo: 'profilesIsAdmin'
  tabela: string
  schema: 'public'
  papelInicial: (payload: PayloadPortal) => string
  /** O contrato usa: a aprovação do 1º acesso é conferida contra `aprovacaoEsperada`. */
  aprovaNoPrimeiroAcesso: (payload: PayloadPortal) => boolean
  /** O contrato usa: com `null`, os casos `pre_aprovacao_*` não se aplicam. */
  preAprovacao: PreAprovacao | null
}

/** Adaptador para public.profiles(id, full_name, is_admin, admin_role): ATR GLOBAL (admin-app). */
export function profilesIsAdmin(opcoes?: OpcoesProfilesIsAdmin): AdaptadorProfilesIsAdmin
