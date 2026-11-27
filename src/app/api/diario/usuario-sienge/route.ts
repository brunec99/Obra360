import { NextResponse } from 'next/server';
import { checkSiengeUser, dailyBody, dailyError, dailyGate, dailyHeaders, dailyText } from '@/infrastructure/daily-report-support';

export const runtime = 'nodejs';

/** Confere o login do Sienge que a pessoa digitou (`{ code, live? }`), sem gravar nada: diz se existe, se
 * está ativo e de quem é, para ela confirmar o nome antes de ligar (o mesmo passo do formulário de compras).
 * A ligação em si é o comando `set_sienge_user`, que confere de novo. `live: true` é o "Verificar de novo". */
export async function POST(request: Request) {
  const gate = await dailyGate('write');
  if (gate instanceof NextResponse) return gate;
  const body = await dailyBody(request);
  if (!body) return dailyError('Corpo da requisição inválido.', 400);
  const check = await checkSiengeUser(dailyText(body.code), { actorId: gate.profile.id }, { live: body.live === true });
  if (check instanceof NextResponse) return check;
  return NextResponse.json(check, { headers: dailyHeaders });
}
