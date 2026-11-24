import type { Metadata, Viewport } from 'next';
import { FieldDiary } from '@/modules/diario/field-app';
import { AccessTracker } from '@/modules/acessos/access-tracker';

export const metadata: Metadata = { title: 'Diário de Obra em campo' };
export const viewport: Viewport = { themeColor: '#0a364d', width: 'device-width', initialScale: 1, viewportFit: 'cover' };
// Casca estática de propósito, como a terminalidade em campo (`/campo/terminalidade`): nada de sessão nem
// banco na renderização. É o que permite ao service worker (`/campo-sw.js`) guardar esta página e abri-la
// sem sinal no canteiro. A obra e a data vêm de `?obra=` e `?data=`, lidas no navegador pela própria tela.
// Os dados vêm das APIs autenticadas (`/api/diario/*`): sem sessão, a tela pede login, e nenhum dado de
// obra chega ao aparelho. O proxy deixa `/campo/` passar sem sessão por isso.
export const dynamic = 'force-static';

// O tempo ativo no modo de campo conta no módulo, marcado "campo" (aba "Acessos" do Dashboard geral).
// O registro só sai com sinal; sem sinal, o minuto se perde.
export default function FieldDiaryPage() {
  return (
    <>
      <FieldDiary />
      <AccessTracker />
    </>
  );
}
