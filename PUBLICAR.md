# PUBLICAR.md: publicação do Obra 360 em produção

Instruções para o agente. Siga todas, na ordem, sempre que o usuário pedir para publicar em produção.
Produção: `https://obra360.atrincorporadora.com.br`. A produção fica presa a um commit; ela só muda por este roteiro.

## Comandos permitidos

```bash
ssh atr-publicar obra360 ver                 # commit e digest no ar, o anterior e as últimas publicações
ssh atr-publicar obra360 publicar <commit>   # 12 primeiros caracteres do commit
ssh atr-publicar obra360 voltar              # volta para a versão anterior
```

Não use nenhum outro comando no servidor. Não tente abrir terminal, copiar arquivos ou ler o `.env`.

## 1. Identificar as versões

- `<novo>`: o commit a publicar, na `main`.
- `<no-ar>`: o commit em produção, o valor de `NO_AR_COMMIT` em `ssh atr-publicar obra360 ver`. Se vier vazio,
  pare e peça ao usuário o commit que está no ar.

## 2. Verificar antes de publicar

Pare no primeiro item que falhar (veja "Quando parar").

1. `gh run list --commit <novo>`: os workflows "CI" e "Imagem" estão com `success`.
2. Liste as migrações novas: `git diff --name-only <no-ar> <novo> -- supabase/migrations`. Se houver, siga
   "Migrações" abaixo antes do item 3.
3. `git diff <no-ar> <novo> -- src | grep -E "^\+.*process\.env\.[A-Z_]+"` não mostra nenhuma variável que não existia em `<no-ar>`.
4. Para cada pacote novo ou com versão nova em `git diff <no-ar> <novo> -- package-lock.json`, rode
   `npm view <pacote>@<versão> time scripts repository --json` e confira:
   - a versão foi publicada há 7 dias ou mais;
   - não tem `preinstall`, `install` nem `postinstall`;
   - o repositório corresponde ao pacote.
5. `npm audit --package-lock-only --omit=dev --audit-level=high` termina sem alerta alto ou crítico.
6. Leia `git log --oneline <no-ar>..<novo>` e o diff de `src/app/api`. Toda rota nova confere login e acesso à obra
   antes de ler ou gravar dados, como as rotas existentes. Nenhum segredo (senha, token, chave) entrou no código.

## Migrações

O banco é o `takt-hub`, que também atende o Takt Hub. A versão no ar continua rodando enquanto a migração é aplicada
e durante a troca do container, então a migração precisa funcionar com as duas versões.

1. `npm run validate:migrations` passa.
2. Cada migração só acrescenta: tabela, coluna que aceita nulo ou tem valor padrão, índice, função, política. Não
   publique de uma vez migração com `drop`, `rename`, troca de tipo, `not null` sem padrão ou que mexa em tabela,
   função ou política do Takt Hub. Divida em duas publicações: primeiro o código que funciona com e sem a mudança,
   depois a migração que remove ou restringe.
3. Toda tabela nova tem RLS ligada e nenhum acesso de `anon`, como as existentes.
4. Aplique no `takt-hub`, em ordem de número, antes de publicar (migração do snapshot ausente derruba todas as
   telas). Confira no catálogo que a mudança entrou e anote o nome da migração para o resumo final.

## 3. Publicar

```bash
ssh atr-publicar obra360 publicar <novo>
```

Se o comando terminar com erro, rode `ssh atr-publicar obra360 voltar` e reporte a saída ao usuário.

## 4. Conferir depois

1. Peça ao usuário para abrir `https://obra360.atrincorporadora.com.br` logado e testar a tela que mudou.
2. Se algo quebrou: `ssh atr-publicar obra360 voltar`, depois investigue.
3. Entregue ao usuário um resumo de uma linha para o administrador do servidor: commit publicado, migrações
   aplicadas, o que mudou, e se foi preciso voltar. Se voltou depois de aplicar migração, diga isso: a migração
   continua no banco.

## Quando parar

Não publique; corrija primeiro, em outro commit, e recomece do item 1:

- CI ou imagem sem `success` (item 1);
- migração que não passa em "Migrações": divida como descrito lá;
- dependência que falhou no item 4 ou alerta no item 5;
- rota sem verificação de acesso ou segredo no código (item 6).

Não publique e diga ao usuário que precisa do administrador do servidor:

- variável nova (item 3): informe o nome e a finalidade, nunca o valor. Publique só depois que ela estiver no `.env`.

## Regras

- A chave `~/.ssh/atr_publicar` não sai do computador do usuário: não copie, não coloque em secret do GitHub, não
  mostre o conteúdo.
- Nginx, certificado, `.env` e qualquer outra mudança no servidor estão fora deste roteiro.
