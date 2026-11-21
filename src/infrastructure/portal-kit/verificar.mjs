#!/usr/bin/env node
// @atr/portal-kit · verificar.mjs — trava de hash da cópia vendorizada.
// Este arquivo é copiado junto com o kit para dentro do app. No CI do app:
//   node <pasta-do-kit>/verificar.mjs          (sai 1 se algum arquivo foi editado, sumiu ou sobrou)
// Mudança no kit não se faz na cópia: vai para airon-lab/atr-portal-kit, nova tag, nova cópia.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const NOME_LOCK = 'PORTAL_KIT.lock'
const PROPRIOS = new Set([NOME_LOCK, 'verificar.mjs'])

export const sha256 = (caminho) => createHash('sha256').update(readFileSync(caminho)).digest('hex')

function listar(pasta, base = pasta) {
  return readdirSync(pasta).flatMap((n) => {
    const c = join(pasta, n)
    return statSync(c).isDirectory() ? listar(c, base) : [relative(base, c).split('\\').join('/')]
  })
}

/** @returns {{ ok: boolean, problemas: string[], lock?: any }} */
export function verificar(pasta) {
  let lock
  try { lock = JSON.parse(readFileSync(join(pasta, NOME_LOCK), 'utf8')) } catch (e) {
    return { ok: false, problemas: [`${NOME_LOCK} ausente ou ilegível em ${pasta}`] }
  }
  const problemas = []
  for (const [arq, esperado] of Object.entries(lock.arquivos ?? {})) {
    let atual
    try { atual = sha256(join(pasta, arq)) } catch { problemas.push(`faltando: ${arq}`); continue }
    if (atual !== esperado) problemas.push(`editado: ${arq}`)
  }
  for (const arq of listar(pasta)) {
    if (!PROPRIOS.has(arq) && !(arq in (lock.arquivos ?? {}))) problemas.push(`sobrando (fora do lock): ${arq}`)
  }
  return { ok: problemas.length === 0, problemas, lock }
}

const principal = import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
if (principal) {
  const pasta = process.argv[2] ?? dirname(fileURLToPath(import.meta.url))
  const r = verificar(pasta)
  if (r.ok) {
    console.log(`portal-kit ${r.lock.versao} (${String(r.lock.commit).slice(0, 7)}): ${Object.keys(r.lock.arquivos).length} arquivos conferidos`)
  } else {
    console.error(`portal-kit: cópia diferente do ${NOME_LOCK}\n  - ${r.problemas.join('\n  - ')}`)
    console.error('Não edite a cópia: altere airon-lab/atr-portal-kit e rode o vendorizar de novo.')
    process.exit(1)
  }
}
