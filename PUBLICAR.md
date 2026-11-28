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
2. `git diff --name-only <no-ar> <novo> -- supabase/migrations` não lista nenhum arquivo.
3. `git diff <no-ar> <novo> -- src | grep -E "^\+.*process\.env\.[A-Z_]+"` não mostra nenhuma variável que não existia em `<no-ar>`.
4. Para cada pacote novo ou com versão nova em `git diff <no-ar> <novo> -- package-lock.json`, rode
   `npm view <pacote>@<versão> time scripts repository --json` e confira:
   - a versão foi publicada há 7 dias ou mais;
   - não tem `preinstall`, `install` nem `postinstall`;
   - o repositório corresponde ao pacote.
5. `npm audit --package-lock-only --omit=dev --audit-level=high` termina sem alerta alto ou crítico.
6. Leia `git log --oneline <no-ar>..<novo>` e o diff de `src/app/api`. Toda rota nova confere login e acesso à obra
   antes de ler ou gravar dados, como as rotas existentes. Nenhum segredo (senha, token, chave) entrou no código.

## 3. Publicar

```bash
ssh atr-publicar obra360 publicar <novo>
```

Se o comando terminar com erro, rode `ssh atr-publicar obra360 voltar` e reporte a saída ao usuário.

## 4. Conferir depois

1. Peça ao usuário para abrir `https://obra360.atrincorporadora.com.br` logado e testar a tela que mudou.
2. Se algo quebrou: `ssh atr-publicar obra360 voltar`, depois investigue.
3. Entregue ao usuário um resumo de uma linha para o administrador do servidor: commit publicado, o que mudou, e
   se foi preciso voltar.

## Quando parar

Não publique e diga ao usuário que a mudança precisa do administrador do servidor quando houver:

- migração nova (item 2): ela altera o banco compartilhado;
- variável nova (item 3): informe o nome e a finalidade, nunca o valor;
- CI ou imagem sem `success` (item 1);
- dependência que falhou no item 4 ou alerta no item 5;
- rota sem verificação de acesso ou segredo no código (item 6): corrija antes, em outro commit.

## Regras

- A chave `~/.ssh/atr_publicar` não sai do computador do usuário: não copie, não coloque em secret do GitHub, não
  mostre o conteúdo.
- Nginx, certificado, `.env`, banco e qualquer outra mudança no servidor estão fora deste roteiro.
