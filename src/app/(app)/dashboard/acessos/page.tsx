import { redirect } from 'next/navigation';
import { getRouteAccess } from '@/infrastructure/auth/supabase-server';
import { AccessOverview } from '@/modules/dashboard/acessos/access-overview';
import { parseAccessParams } from '@/modules/dashboard/acessos/params';

export const metadata = { title: 'Acessos · Dashboard geral' };

/** Aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado "Aba Acessos no Dashboard geral"): quem entrou no
 * Obra 360, em quais módulos e por quanto tempo. Só admin (regra 2): os demais voltam para a aba Obras, como nas
 * outras telas de administração, em vez de ver uma tela vazia. Período e filtros vêm da URL (`params.ts`). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { profile } = await getRouteAccess();
  if (profile?.role !== 'admin') redirect('/dashboard');
  return <AccessOverview initial={parseAccessParams(await searchParams)} />;
}
