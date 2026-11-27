import { hasSectionAccess } from '@/application/module-access';
import { redirect } from 'next/navigation';
import { getRouteAccess } from '@/infrastructure/auth/supabase-server';
import { FederationHub } from '@/modules/federacao/federation-hub';
export const metadata = { title: 'Modelo federado' };
export default async function Page({ params }: { params: Promise<{ obraId: string }> }) {
  const { obraId } = await params;
  // Módulo em desenvolvimento: o proxy já desvia quem não desenvolve; a página confere de novo.
  const access = await getRouteAccess();
  if (!hasSectionAccess('federacao', access)) redirect(`/obras/${encodeURIComponent(obraId)}/dashboard`);
  return <FederationHub key={obraId} workId={obraId} />;
}
