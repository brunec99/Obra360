# Publicar o Obra 360 em produção

Protocolo para publicar uma versão do Obra 360 em `https://obra360.atrincorporadora.com.br` (servidor da ATR).
Quem publica é o Bruno. Se você é o Claude do Bruno, siga este roteiro inteiro antes de cada publicação e
pare onde ele manda parar.

A homologação (`planejamento-teste`) segue a `latest` sozinha. A produção não: ela fica presa a um commit e só
muda quando alguém publica por aqui.

## O comando

O servidor só aceita estes comandos da chave de publicação. Não há terminal, e a chave não alcança mais nada no
servidor.

```bash
ssh atr-publicar obra360 ver                 # commit e digest no ar, e o anterior
ssh atr-publicar obra360 publicar <commit>   # publica a imagem daquele commit (12 primeiros caracteres)
ssh atr-publicar obra360 voltar              # volta para a versão anterior
```

O `publicar` baixa a imagem `ghcr.io/brunec99/obra360:<commit>`, fixa pelo digest, troca o container e confere a
tela de login. Se o login não responder, ele avisa e mostra como voltar. Cada publicação fica registrada no
servidor com data, commit e digest.

## Antes de publicar

`<no-ar>` é o commit que `ssh atr-publicar obra360 ver` mostra. `<novo>` é o commit a publicar.

1. **O commit está na `main` e passou na CI.** O workflow "CI" e o "Imagem" estão verdes para esse commit:
   `gh run list --commit <novo>`.
2. **Migração nova: pare.** Se `git diff --name-only <no-ar> <novo> -- supabase/migrations` listar algum
   arquivo, não publique. Migração mexe no banco compartilhado com o Takt e é aplicada pelo Thiago. Mande a ele o
   commit e o nome da migração.
3. **Variável nova: pare.** Se `git diff <no-ar> <novo> -- src | grep -E "process\.env\.[A-Z_]+"` mostrar uma
   variável que não existia, não publique. O `.env` da produção é do Thiago: mande o nome da variável e para que
   serve (o valor vai por canal separado, nunca por e-mail ou chat).
4. **Dependência nova: confira cada uma.** Para cada pacote novo ou com versão nova em
   `git diff <no-ar> <novo> -- package-lock.json`:
   - `npm view <pacote>@<versão> time scripts repository --json`;
   - **pare** se a versão foi publicada há menos de 7 dias, se tem `preinstall`, `install` ou `postinstall`, ou se
     o repositório não bate com o nome do pacote. Ataques de supply chain usam versões recém-publicadas.
   - `npm audit --package-lock-only --omit=dev --audit-level=high` precisa sair sem alerta alto ou crítico.
5. **Leia o que muda.** `git log --oneline <no-ar>..<novo>` e o diff das rotas em `src/app/api`. Rota nova
   precisa conferir login e acesso à obra antes de ler ou gravar qualquer dado (como as rotas que já existem).

Se parou em algum passo, explique ao Bruno o motivo e chame o Thiago (thiago@aironlab.com.br).

## Publicar

```bash
ssh atr-publicar obra360 publicar <novo>
```

## Depois de publicar

1. Abra `https://obra360.atrincorporadora.com.br` logado e teste a tela que mudou.
2. Se algo quebrou: `ssh atr-publicar obra360 voltar`, e só depois investigue.
3. Avise o Thiago: commit publicado, o que mudou em uma linha, e se precisou voltar.

## O que não passa por aqui

- Migração no banco, variável no `.env`, nginx, certificado e qualquer outra coisa no servidor: com o Thiago.
- A chave de publicação fica só no computador do Bruno (`~/.ssh/atr_publicar`). Não copie, não ponha em
  secret do GitHub e não mande a ninguém. Se o computador for perdido ou invadido, avise o Thiago para apagá-la.
