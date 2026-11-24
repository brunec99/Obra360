import { DiaryOverview } from '@/modules/diario/diary-overview';
export const metadata = { title: 'Diário de Obra' };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string }>;
  searchParams: Promise<{ data?: string }>;
}) {
  const { obraId } = await params;
  const { data } = await searchParams;
  return <DiaryOverview workId={obraId} initialDate={typeof data === 'string' ? data : undefined} />;
}
