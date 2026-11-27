import { NextResponse } from 'next/server';
import { takeSiengeUserCheck } from '@/domain/sienge-daily-report';
import { checkSiengeUser, dailyBody, dailyError, dailyGate, dailyHeaders, dailyText } from '@/infrastructure/daily-report-support';

export const runtime = 'nodejs';

// shortcut: limite na memória do processo (um container só), zera ao reiniciar; evoluir para o banco se o Obra 360 passar a ter mais de uma instância.
const checksByProfile = new Map<string, number[]>();

/** Confere o login do Sienge que a pessoa digitou (`{ code, live? }`), sem gravar nada: diz se existe, se
 * está ativo e de quem é, para ela confirmar o nome antes de ligar (o mesmo passo do formulário de compras).
 * A ligação em si é o comando `set_sienge_user`, que confere de novo. `live: true` é o "Verificar de novo". */
export async function POST(request: Request) {
  const gate = await dailyGate('write');
  if (gate instanceof NextResponse) return gate;
  // Sem limite, a rota responderia o nome do dono de qualquer login: daria para varrer os usuários do Sienge.
  const slot = takeSiengeUserCheck(checksByProfile.get(gate.profile.id) ?? [], Date.now());
  checksByProfile.set(gate.profile.id, slot.history);
  if (!slot.allowed) return dailyError('Muitas conferências seguidas. Aguarde alguns minutos e tente de novo.', 429);
  const body = await dailyBody(request);
  if (!body) return dailyError('Corpo da requisição inválido.', 400);
  const check = await checkSiengeUser(dailyText(body.code), { actorId: gate.profile.id }, { live: body.live === true });
  if (check instanceof NextResponse) return check;
  return NextResponse.json(check, { headers: dailyHeaders });
}
