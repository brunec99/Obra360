/** Estilo próprio da aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado "Aba Acessos no Dashboard
 * geral"), somado a `DASHBOARD_STYLE` (as classes `dsh-*` dos quadros, dos cartões, da frase e dos selos). Só tela:
 * a aba não tem PDF (regra 13). Cores fixas, as mesmas do modelo e da paleta do sistema; o app é só tema claro.
 * Prefixo `ac-` (acessos):
 * - `.ac-kpis` contêiner dos seis cartões; `.dsh-kpis.ac6` dois por linha no celular, três na largura média e os
 *   seis numa linha quando a área do conteúdo é larga (consulta de contêiner, porque a lateral muda a largura);
 * - `.ac-up .ac-down .ac-eq` a seta do comparativo; `.ac-live` a bolinha verde de "agora";
 * - `.ac-g-*` as cores dos grupos do menu (dash, prazo, ctrl, sst, adm) e `.ac-g-work` a das obras;
 * - `.ac-xscroll` rolagem de lado das tabelas, também contêiner (o detalhe usa `100cqw` para ficar na parte
 *   visível); `table.ac-table` a tabela "Por pessoa": coluna da pessoa fixa, títulos que ordenam, `tr.link` linha
 *   que abre o detalhe, `tr.off` quem não entrou (apagado), `tr.ac-detail` o detalhe aberto embaixo;
 * - `.ac-dots` um quadradinho por dia do período (`.dense` acima de 14 dias); `.ac-stack` barra empilhada dos grupos;
 * - `.ac-bars` barras de tempo por módulo e por obra (nome, barra, tempo, pessoas ou %), com `.dsh-track` de trilho;
 * - `.ac-sess` as sessões do detalhe; `.ac-detail-grid` sessões à esquerda e barras à direita (uma coluna no celular);
 * - `table.ac-heat` o "Uso por dia": `.z0` a `.z4` a rampa dos minutos e `.ac-ramp` a legenda;
 * - `.ac-cols-2` "Tempo por módulo" e "Tempo por obra" lado a lado (um embaixo do outro no celular);
 * - `.ac-stale` o período anterior apagado enquanto o novo carrega. */
export const ACCESS_STYLE = `
.ac-kpis { container-type: inline-size; }
.dsh .dsh-kpis.ac6 { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
@container (min-width: 560px) { .dsh .dsh-kpis.ac6 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (min-width: 1000px) {
  .dsh .dsh-kpis.ac6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .dsh .dsh-kpis.ac6 .dsh-stat { padding: 11px 12px 12px; }
  .dsh .dsh-kpis.ac6 .dsh-stat::before { left: 12px; right: 12px; }
  .dsh .dsh-kpis.ac6 .dsh-stat .v { font-size: 22px; gap: 6px; }
}
.dsh-stat .v small { font-size: 13px; font-weight: 600; color: #59738a; }
.dsh-stat .v .ac-live { align-self: center; margin-right: 0; }
.dsh-callout.ac-callout { margin: 0 0 16px; }
.dsh-mod-b.ac-legend-b { padding-bottom: 10px; }
.ac-up { color: #047857; font-weight: 700; }
.ac-down { color: #be123c; font-weight: 700; }
.ac-eq { color: #475569; font-weight: 700; }
.ac-live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #047857; box-shadow: 0 0 0 3px #ecfdf5; flex: none; vertical-align: 1px; margin-right: 5px; }
.ac-stale { opacity: .55; transition: opacity .15s; pointer-events: none; }

/* Grupos do menu */
.dsh .ac-g-dash { background: #6366f1; }
.dsh .ac-g-prazo { background: #2a78d6; }
.dsh .ac-g-ctrl { background: #0d9488; }
.dsh .ac-g-sst { background: #d97706; }
.dsh .ac-g-adm { background: #94a3b8; }
.dsh .ac-g-work { background: #2a78d6; }
.ac-legend { margin: 0; }

/* Tabela "Por pessoa" */
.ac-xscroll { overflow-x: auto; max-width: 100%; container-type: inline-size; }
table.ac-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ac-table th { text-align: left; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #59738a; padding: 8px 10px 6px; border-bottom: 1px solid #c4d3df; white-space: nowrap; vertical-align: bottom; background: #fff; }
.ac-table th.num, .ac-table td.num { text-align: right; }
.ac-table th button { all: unset; cursor: pointer; display: inline-flex; gap: 3px; align-items: center; border-radius: 4px; }
.ac-table th button:focus-visible { outline: 2px solid #2a8cc0; outline-offset: 2px; }
.ac-table th[aria-sort="ascending"] button, .ac-table th[aria-sort="descending"] button { color: #1a719f; }
.ac-table th .ar { display: inline-block; min-width: 8px; color: #1a719f; }
.ac-table td { padding: 7px 10px; border-bottom: 1px solid #ebf1f6; vertical-align: top; background: #fff; color: #0d1f2b; }
.ac-table td.num { white-space: nowrap; }
.ac-table td small { display: block; font-size: 11px; font-weight: 400; color: #59738a; line-height: 1.35; margin-top: 1px; }
.ac-table th:first-child, .ac-table td:first-child { position: sticky; left: 0; z-index: 1; box-shadow: 1px 0 0 #ebf1f6; }
.ac-table td.who { min-width: 160px; max-width: 240px; }
.ac-table td.who b { font-weight: 700; }
.ac-table td.who .dsh-tag { margin-left: 4px; }
.ac-table td.dev { white-space: nowrap; }
.ac-table td.last { min-width: 150px; }
.ac-table td.days { white-space: nowrap; }
.ac-table th:first-child, .ac-table td:first-child { padding-left: 16px; }
.ac-table th:last-child, .ac-table td:last-child { padding-right: 16px; }
.ac-table td.where { min-width: 170px; }
.ac-table tbody tr.link { cursor: pointer; }
.ac-table tbody tr.link:hover td { background: #f5f9fc; }
.ac-table tbody tr.link:focus-visible { outline: none; }
.ac-table tbody tr.link:focus-visible td { box-shadow: inset 0 2px 0 #2a8cc0, inset 0 -2px 0 #2a8cc0; }
.ac-table tbody tr.open td { background: #eaf4fa; }
.ac-table tbody tr.off td { color: #8ea4b7; }
.ac-table tbody tr.off td.who b { color: #59738a; font-weight: 600; }
.ac-table tbody tr.off td .dsh-tag { opacity: 1; }
.ac-table tr.ac-detail > td { position: static; background: #f5f8fb; padding: 0; box-shadow: none; }
.ac-table td.ac-none { text-align: center; color: #59738a; padding: 14px 10px; }
.ac-detail-in { position: sticky; left: 0; width: 100cqw; box-sizing: border-box; padding: 12px 16px 14px; }

.ac-dots { display: flex; flex-wrap: wrap; gap: 2px; margin-top: 3px; max-width: 126px; }
.ac-dots i { width: 7px; height: 7px; border-radius: 2px; background: #e2e8f0; }
.ac-dots i.on { background: #2a78d6; }
.ac-dots.dense { gap: 1px; }
.ac-dots.dense i { width: 5px; height: 5px; border-radius: 1px; }
.ac-stack { display: flex; height: 9px; border-radius: 2px; overflow: hidden; background: #eef3f7; min-width: 120px; margin-top: 3px; }
.ac-stack b { display: block; height: 100%; }

/* Barras de tempo */
.ac-bars { display: grid; font-size: 12.5px; min-width: 0; }
.ac-bars > div { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) 62px 52px; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid #ebf1f6; min-width: 0; }
.ac-bars > div:last-child { border-bottom: 0; }
.ac-bars > .thd { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #59738a; border-bottom-color: #c4d3df; padding: 0 0 4px; }
.ac-bars .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ac-bars .n { color: #59738a; font-weight: 650; margin-right: 4px; }
.ac-bars .r { text-align: right; white-space: nowrap; }
.ac-bars .p { text-align: right; color: #59738a; font-size: 11.5px; white-space: nowrap; }
.ac-bars > .thd .r, .ac-bars > .thd .p { font-size: 10px; color: #59738a; }
.ac-bars .dsh-track > b { min-width: 2px; }
.ac-note { margin: 0; font-size: 11.5px; color: #59738a; line-height: 1.45; }
.ac-empty { margin: 0; font-size: 12.5px; color: #59738a; line-height: 1.45; }
.ac-cols-2 { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); align-items: start; }

/* Detalhe de uma pessoa */
.ac-detail-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px 20px; }
@container (max-width: 760px) { .ac-detail-grid { grid-template-columns: minmax(0, 1fr); } }
.ac-mini-h { margin: 0 0 6px; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #59738a; }
.ac-sess { display: grid; gap: 6px; }
.ac-sess > div { background: #fff; border: 1px solid #ebf1f6; border-radius: 8px; padding: 7px 10px; font-size: 12px; }
.ac-sess .top { display: flex; justify-content: space-between; gap: 2px 10px; flex-wrap: wrap; font-weight: 650; color: #0d1f2b; }
.ac-sess .top span:last-child { color: #59738a; font-weight: 600; }
.ac-sess .mods { color: #59738a; margin-top: 2px; line-height: 1.4; overflow-wrap: anywhere; }
.ac-detail-side { display: grid; gap: 14px; align-content: start; min-width: 0; }
.ac-detail-side .ac-bars > div { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) 56px 40px; }
.ac-more { margin-top: 8px; font-size: 12px; }

/* Uso por dia */
table.ac-heat { border-collapse: separate; border-spacing: 0; font-size: 12px; font-variant-numeric: tabular-nums; width: 100%; }
.ac-heat th { font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #59738a; padding: 8px 2px 6px; border-bottom: 1px solid #c4d3df; white-space: nowrap; text-align: center; background: #fff; line-height: 1.25; }
.ac-heat th small { display: block; font-size: 10px; font-weight: 600; letter-spacing: 0; text-transform: none; }
.ac-heat th:first-child { text-align: left; padding-left: 16px; padding-right: 10px; }
.ac-heat th.tot { text-align: right; padding: 8px 16px 6px 10px; }
.ac-heat td { padding: 3px 2px; border-bottom: 1px solid #ebf1f6; background: #fff; }
.ac-heat th:first-child, .ac-heat td:first-child { position: sticky; left: 0; z-index: 1; box-shadow: 1px 0 0 #ebf1f6; }
.ac-heat td.nm { white-space: nowrap; padding: 3px 10px 3px 16px; font-weight: 600; color: #1b3348; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.ac-heat td.h { text-align: center; min-width: 40px; }
.ac-heat td.h span { display: block; border-radius: 4px; padding: 4px 0; font-size: 11px; font-weight: 650; }
.ac-heat td.tot { text-align: right; padding: 3px 16px 3px 10px; font-weight: 700; white-space: nowrap; }
.ac-heat tr.total td { font-weight: 700; color: #1b3348; border-top: 1px solid #c4d3df; border-bottom: 0; text-align: center; padding-top: 6px; padding-bottom: 6px; }
.ac-heat tr.total td.nm, .ac-heat tr.total td.tot { text-align: inherit; }
.ac-heat tr.total td.tot { text-align: right; }
.z0 span { background: #eef3f7; color: transparent; }
.z1 span { background: #dbeafe; color: #1b3348; }
.z2 span { background: #93c5fd; color: #0d1f2b; }
.z3 span { background: #3b82f6; color: #fff; }
.z4 span { background: #1d4ed8; color: #fff; }
.ac-ramp { display: inline-flex; gap: 3px; align-items: center; font-size: 11px; color: #59738a; vertical-align: -1px; }
.ac-ramp i { width: 18px; height: 10px; border-radius: 2px; display: inline-block; }
`;
