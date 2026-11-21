/** Caminho dos arquivos de um modelo IFC no bucket `ifc`.
 *
 * Quem monta o caminho é o servidor (`/api/ifc/upload-url`): `<obra>/<modelo>/<uuid>-<nome saneado>`. Depois
 * do envio direto ao Storage, o navegador devolve esse caminho para registrar a versão (`add_ifc_version`)
 * ou a geometria convertida (`/api/ifc/fragments`). Sem conferir o que volta, quem tem acesso a uma obra
 * poderia registrar o caminho de um arquivo de OUTRA obra: o servidor assina o download com a chave de
 * serviço (e o registro novo dos fragments apaga o arquivo anterior). Por isso o caminho só vale se for
 * exatamente do formato que o próprio servidor gera para aquele modelo.
 *
 * Funções puras, sem rede. */

const NOME_SANEADO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,80}$/i;

/** Prefixo dos arquivos de um modelo: `<obra>/<modelo>/`. */
export const ifcStoragePrefix = (workId: string, modelId: string) => `${workId}/${modelId}/`;

/** `true` se `path` é um arquivo deste modelo no formato do servidor, com a extensão pedida (ex.: `ifc`, `frag`). */
export function isIfcStoragePathOf(path: string, model: { id: string; workId: string }, extension?: 'ifc' | 'frag'): boolean {
  const prefix = ifcStoragePrefix(model.workId, model.id);
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  // Sem barra (subpasta) e sem `..`: o nome tem de ser um só segmento, como o servidor gera.
  if (!NOME_SANEADO.test(name) || name.includes('..')) return false;
  return extension ? name.toLowerCase().endsWith(`.${extension}`) : true;
}

export const IFC_PATH_INVALIDO = 'Arquivo enviado fora do lugar deste modelo. Envie o arquivo de novo.';
