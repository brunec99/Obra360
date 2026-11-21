// Tipos de server/adaptador-rpc-comercial.mjs (@atr/portal-kit), escritos à mão, sem dependência.

import type { AdaptadorPerfil } from './receptor.d.mts'

export interface OpcoesRpcComercial {
  /** Padrão 'comercial'. */
  schema?: string
  /** Padrão 0. */
  esperarGatilhoMs?: number
  /**
   * @deprecated Sem efeito: `entrada_portal` cria o perfil de quem não tem (o `ler` sempre devolve
   * `existe: true`), então o receptor nunca recusa por perfil ausente. Aceito só por compatibilidade.
   */
  semPerfilEmContaExistente?: 'criar' | 'recusar'
  /**
   * v0.3.0. O que fazer quando a RPC `entrada_portal` devolve a situação 'pendente'. Padrão `false`:
   * 403 `acesso_bloqueado`, sem magic link. Só `true` dá sessão ao pendente (o app mostra a tela), com
   * o papel que a RPC devolveu. Situação desconhecida continua 503. Quem decide quem fica pendente é
   * a RPC: aqui não há `aprovaNoPrimeiroAcesso` nem `preAprovacao`.
   */
  sessaoParaPendente?: boolean
}

/** O adaptador do Comercial: `AdaptadorPerfil` com o que o contrato lê. */
export interface AdaptadorRpcComercial extends AdaptadorPerfil {
  tipo: 'rpcComercial'
  schema: string
  /** v0.3.0: `true` só quando a opção veio exatamente `true`. O contrato usa no caso `rpc_pendente`. */
  sessaoParaPendente: boolean
}

/** Adaptador por RPC (usuario_por_email, entrada_portal): Portal Comercial. */
export function rpcComercial(opcoes?: OpcoesRpcComercial): AdaptadorRpcComercial
