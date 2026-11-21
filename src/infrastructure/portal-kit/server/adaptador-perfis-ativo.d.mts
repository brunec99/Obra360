// Tipos de server/adaptador-perfis-ativo.mjs (@atr/portal-kit), escritos à mão, sem dependência.

import type { PayloadPortal } from '../core/ssoV2.d.mts'
import type { PreAprovacao } from './pre-aprovacao.d.mts'
import type { AdaptadorPerfil } from './receptor.d.mts'

export interface OpcoesPerfisAtivo {
  /** Padrão: portal_role 'admin' → 'admin', senão 'colaborador'. */
  papelInicial?: (payload: PayloadPortal) => string
  /** Padrão 'criar'. */
  semPerfilEmContaExistente?: 'criar' | 'recusar'
  /** Padrão 'rh'. */
  schema?: string
  /** Padrão 'perfis'. */
  tabela?: string
  /** Padrão 0. */
  esperarGatilhoMs?: number
  /** Padrão 'papel'. */
  campoPapelResposta?: string
  /**
   * v0.3.0: nome da coluna PRÓPRIA de aprovação do app (boolean; ex.: 'aprovado'). Só `true` nela
   * libera. Nunca `ativo`: desativado é outra coisa. Padrão `null` (sem estado pendente, como na v0.2.5).
   * Obrigatória quando `aprovaNoPrimeiroAcesso` ou `preAprovacao` são declarados (sem ela a fábrica lança).
   */
  colunaAprovado?: string | null
  /**
   * v0.3.0: o 1º acesso aprova? Só `true` aprova. Padrão `() => true` (como na v0.2.5).
   * Com falso e sem pré-aprovação, o perfil nasce com a coluna de aprovação em `false` e `ativo: true`.
   */
  aprovaNoPrimeiroAcesso?: (payload: PayloadPortal) => boolean
  /**
   * v0.3.0: leitor e marcador da pré-aprovação (`criarPreAprovacao`). Com linha válida, o perfil nasce
   * aprovado no papel da linha. Padrão `null` (como na v0.2.5).
   */
  preAprovacao?: PreAprovacao | null
}

/** O adaptador do RH: `AdaptadorPerfil` com o que o contrato lê. */
export interface AdaptadorPerfisAtivo extends AdaptadorPerfil {
  tipo: 'perfisAtivo'
  tabela: string
  schema: string
  papelInicial: (payload: PayloadPortal) => string
  /** O contrato usa: sem a coluna, os casos de pendência não se aplicam. */
  colunaAprovado: string | null
  /** O contrato usa: a aprovação do 1º acesso é conferida contra `aprovacaoEsperada`. */
  aprovaNoPrimeiroAcesso: (payload: PayloadPortal) => boolean
  /** O contrato usa: com `null`, os casos `pre_aprovacao_*` não se aplicam. */
  preAprovacao: PreAprovacao | null
}

/** Adaptador para rh.perfis(user_id, nome, email, papel, ativo): Portal RH. */
export function perfisAtivo(opcoes?: OpcoesPerfisAtivo): AdaptadorPerfisAtivo
