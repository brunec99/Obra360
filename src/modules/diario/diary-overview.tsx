'use client';
import Link from 'next/link';
import { Smartphone } from 'lucide-react';
import { TabHeader } from '@/modules/layout/tab-header';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { LoadState, Missing } from '@/modules/planejamento/ui';
import { DiaryEditor } from './diary-editor';

/** Aba 2.4, Diário de Obra (24/11/2026): o cabeçalho da aba e o editor, que é o mesmo do modo de campo
 * (`/campo/diario`). O planejamento só entra aqui para dizer o nome da obra e conferir o acesso; o diário tem
 * leitura e gravação próprias (`/api/diario/*`), fora do snapshot. */
export function DiaryOverview({ workId, initialDate }: { workId: string; initialDate?: string }) {
  const context = usePlanning();
  if (context.state !== 'ready') return <LoadState error={context.state === 'error'} />;
  const { planning } = context;
  const work = planning.data.works.find(w => w.id === workId);
  const actor = planning.data.users.find(u => u.id === context.actorId);
  if (!work || !actor?.workIds.includes(workId)) return <Missing label="Obra não encontrada" />;
  const fieldHref = `/campo/diario?obra=${encodeURIComponent(work.id)}&nome=${encodeURIComponent(work.name)}&codigo=${encodeURIComponent(work.code)}`;
  return (
    <>
      <TabHeader
        workId={workId}
        section="diario"
        description="O diário do dia, preenchido aqui e enviado ao Sienge pelo botão."
        help={
          <>
            <p>Um diário por obra e dia: clima e jornada, atividades, mão de obra, equipamentos, ocorrências, observações e fotos.</p>
            <p>
              O que você preenche fica guardado no aparelho a cada alteração e é salvo no servidor em seguida. Sem sinal, fica na fila e
              sobe sozinho quando o sinal volta.
            </p>
            <p>A mão de obra é o histograma do dia (2.2): um lançamento só, visto nas duas telas.</p>
            <p>
              Nada vai ao Sienge sozinho. O botão “Enviar ao Sienge” mostra a conferência antes; depois de enviado, o diário fica travado.
            </p>
          </>
        }
      >
        <Link href={fieldHref} className="button-ghost min-h-11">
          <Smartphone size={16} aria-hidden /> Abrir no modo de campo
        </Link>
      </TabHeader>
      <DiaryEditor
        workId={workId}
        workName={work.name}
        initialDate={initialDate}
        settingsHref={`/obras/${workId}/configuracoes`}
        navTop="top-14"
        loginHref={`/login?redirect=${encodeURIComponent(`/obras/${workId}/diario`)}`}
      />
    </>
  );
}
