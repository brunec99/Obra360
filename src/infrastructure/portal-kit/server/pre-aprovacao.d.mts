// Tipos de server/pre-aprovacao.mjs (@atr/portal-kit), escritos à mão, sem dependência.

import type { ClienteAdmin, ContextoPerfil, UsuarioAuth } from './receptor.d.mts'

/** De onde veio a linha. Entre as válidas, a ordem de escolha é convite > pedido > carga. */
export type OrigemPreAprovacao = 'convite' | 'pedido' | 'carga'

/** Linha da tabela de pré-aprovação do app, como o leitor a devolve (sem `convite_expira_em`). */
export interface LinhaPreAprovacao {
  id: string
  /** Slug do Portal. */
  app: string
  /** Em minúsculas e sem espaços. */
  email: string
  origem: OrigemPreAprovacao
  convite_id?: string | null
  /** Papel que a conta recebe; sempre um dos `papeis` da fábrica. */
  papel: string
  /** O que mais o app aplica (obras, cargo…); quem interpreta é o `aplicarExtras` do app. */
  extras?: Record<string, unknown> | null
  criado_por?: string | null
  criado_em: string
  /** Única validade que o leitor confere. O prazo é de quem grava a linha. */
  vale_ate: string
}

export interface OpcoesPreAprovacao {
  /** Padrão 'public'. */
  schema?: string
  /** Padrão 'pre_aprovacao'. */
  tabela?: string
  /** Slug do Portal: só linha deste app vale. Obrigatório. */
  appSlug: string
  /** Lista FECHADA dos papéis que a pré-aprovação pode dar (nunca o papel de topo). Obrigatória e não vazia. */
  papeis: readonly string[]
  /** Valores de `app_metadata.criado_por` que também provam a origem da conta (ex.: o aceite do convite). Padrão []. */
  marcaExtra?: readonly string[]
  /** Roda antes de marcar a linha; erro lança (503) e a linha continua pendente. Tem de ser idempotente. */
  aplicarExtras?: (admin: ClienteAdmin, usuario: UsuarioAuth, pre: LinhaPreAprovacao, ctx: ContextoPerfil) => Promise<void>
}

/** O que o adaptador de perfil recebe em `preAprovacao`. */
export interface PreAprovacao {
  /**
   * A linha que vale para esta conta (quatro condições; janela de 15 minutos de vida para conta que
   * não nasceu neste acesso), ou `null`. Erro de leitura LANÇA.
   */
  ler: (admin: ClienteAdmin, usuario: UsuarioAuth, ctx: ContextoPerfil) => Promise<LinhaPreAprovacao | null>
  /** Roda os extras e marca `aplicado` TODAS as linhas pendentes do app e do e-mail. Erro LANÇA. */
  aplicar: (admin: ClienteAdmin, usuario: UsuarioAuth, pre: LinhaPreAprovacao, ctx: ContextoPerfil) => Promise<void>
  /** O contrato lê (onde semear a tabela no cliente falso). */
  schema?: string
  /** O contrato lê. */
  tabela?: string
  /** Informativo. */
  appSlug?: string
  /** O contrato lê: nenhum papel fora do que o app declarou pode estar aqui. */
  papeis?: readonly string[]
  /** Informativo. */
  marcaExtra?: readonly string[]
}

/** O que `criarPreAprovacao` devolve: `PreAprovacao` com os campos informativos preenchidos. */
export interface PreAprovacaoDeFabrica extends PreAprovacao {
  schema: string
  tabela: string
  appSlug: string
  papeis: readonly string[]
  marcaExtra: readonly string[]
}

/** Leitor e marcador da pré-aprovação local por e-mail. Lança na carga se a configuração for inválida. */
export function criarPreAprovacao(opcoes: OpcoesPreAprovacao): PreAprovacaoDeFabrica
