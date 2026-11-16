import { getRouteAccess } from '@/infrastructure/auth/supabase-server';
import { PortfolioOverview } from '@/modules/dashboard/portfolio/portfolio-overview';
import { parsePortfolioParams } from '@/modules/dashboard/portfolio/params';

export const metadata = { title: 'Dashboard geral' };

/** Dashboard geral (04/11/2026, modelo aprovado "Dashboard geral e escalas de tempo"): fora das obras, os
 * quadros do dashboard para todas as obras liberadas para a pessoa, comparadas no período escolhido. Cada
 * pessoa vê só as próprias obras e os quadros dos módulos que pode abrir (decidido no cliente pelo mesmo
 * `hasSectionAccess` das abas). Escala, período, obras e quadros vêm da URL, para o link reproduzir a visão.
 * Desde 15/11/2026 o admin vê as abas "Obras" e "Acessos" (modelo "Aba Acessos no Dashboard geral", regras 1 e 2). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [raw, { profile }] = await Promise.all([searchParams, getRouteAccess()]);
  return <PortfolioOverview initial={parsePortfolioParams(raw)} tabs={profile?.role === 'admin'} />;
}
