// Tipos de server/adaptador-profiles-approved.mjs (@atr/portal-kit), escritos à mão, sem dependência.

import type { PayloadPortal } from '../core/ssoV2.d.mts'
import type { PreAprovacao } from './pre-aprovacao.d.mts'
import type { AdaptadorPerfil } from './receptor.d.mts'

export interface OpcoesProfilesApproved {
  /** Papel de perfil NOVO (nunca de existente). Padrão: () => 'user'. */
  papelInicial?: (payload: PayloadPortal) => string
  /** Padrão 'criar' (BI); o NF usa 'recusar'. */
  semPerfilEmContaExistente?: 'criar' | 'recusar'
  /** Padrão 'profiles'. */
  tabela?: string
  /** Padrão 500. */
  esperarGatilhoMs?: number
  /** Padrão 'role'. */
  campoPapelResposta?: string
  /**
   * v0.3.0: o 1º acesso aprova? Só `true` aprova. Padrão `() => true` (como na v0.2.5).
   * Com falso e sem pré-aprovação, o perfil nasce pendente e o app mostra a tela de pendente.
   */
  aprovaNoPrimeiroAcesso?: (payload: PayloadPortal) => boolean
  /**
   * v0.3.0: leitor e marcador da pré-aprovação (`criarPreAprovacao`). Com linha válida, o perfil nasce
   * aprovado no papel da linha. Padrão `null` (como na v0.2.5).
   */
  preAprovacao?: PreAprovacao | null
}

/** O adaptador do BI e do NF: `AdaptadorPerfil` com o que o contrato lê. */
export interface AdaptadorProfilesApproved extends AdaptadorPerfil {
  tipo: 'profilesApproved'
  tabela: string
  schema: 'public'
  papelInicial: (payload: PayloadPortal) => string
  /** O contrato usa: a aprovação do 1º acesso é conferida contra `aprovacaoEsperada`. */
  aprovaNoPrimeiroAcesso: (payload: PayloadPortal) => boolean
  /** O contrato usa: com `null`, os casos `pre_aprovacao_*` não se aplicam. */
  preAprovacao: PreAprovacao | null
}

/** Adaptador para public.profiles(id, email, full_name, role, approved): Mapa BI e NF. */
export function profilesApproved(opcoes?: OpcoesProfilesApproved): AdaptadorProfilesApproved
