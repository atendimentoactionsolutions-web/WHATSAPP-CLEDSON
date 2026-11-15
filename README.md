# WHATSAPP CLEDSON

Repositório do projeto **WHATSAPP CLEDSON**, sincronizado automaticamente com o GitHub.

## Recuperação e acompanhamento de recebimento

Execute com Node.js 20 e `npm ci`, depois `npm start`. Validação sem conexão
com WhatsApp: `npm test`.

- `data/delivery.sqlite` guarda protobufs de mensagens de saída antes do envio,
  recibos e diagnósticos de recuperação. Não armazena o binário das fotos nem
  o histórico de entrada dos grupos. Retenção: 30 dias / até 50 mil mensagens,
  limpeza horária, arquivos restritos ao usuário do processo.
- Envio submetido não é confirmação de recebimento. Em grupos, o painel informa
  mensagens com recibo de **pelo menos um participante**, sem afirmar entrega a
  todos. Recibos dos próprios dispositivos são desconsiderados.
- A campanha pausa se houver erro explícito, 3 mensagens sem confirmação por
  mais de 2 minutos, ou pelo menos 5 pedidos de recuperação de uma mensagem.
  Ausência de recibo é incerteza, não prova de falha. A pausa é preservada na fila.
- O envio consulta os dispositivos atuais e redistribui a chave existente do
  grupo. As credenciais e as chaves de criptografia não são apagadas.
- Pedidos de recuperação usam o conteúdo persistido e o ID original. Um envio
  ambíguo não gera automaticamente um novo ID, inclusive ao retomar uma campanha.
- Mensagens anteriores à implantação não podem ser reconstruídas pelo banco.
  Não faça reenvios em massa para tentar corrigir mensagens antigas.
- `GET /status` inclui `delivery` e `recovery`. `POST /send` retorna `messageId`
  e `delivery: unconfirmed`; `success` significa submissão sem erro local.
  Para enviar um anúncio existente a um destino explícito, aceita `adId` em vez
  de `message/text`, preservando imagem e legenda sem alterar grupos selecionados.

A validação automatizada usa sockets simulados. Um teste no próprio número não
comprova recebimento em todos os membros de grupos. Não enviar testes aos grupos
ou clientes sem autorização explícita.

## Publicação na VPS

`scripts/deploy-vps.sh` recebe uma pasta com código e dependências já instaladas.
Exige campanha ociosa, faz backup privado, publica somente este projeto e retorna
à versão anterior se a verificação de conexão falhar. As chaves de sessão nunca
são restauradas automaticamente sobre uma conexão mais recente.

O watchdog compartilhado em `/usr/local/bin/healthcheck-buscador.sh` deve respeitar
`.git/codex-maintenance` no bloco do Cledson. Nesta VPS, esse bloco também evita
`git reset --hard` quando há alterações locais, preservando correções ainda não
publicadas no GitHub. A atualização deste incidente foi aplicada na VPS e no
workspace; não foi enviado commit ao GitHub.

Os logs deste aplicativo são rotacionados a partir de 25 MB (verificação horária),
com quatro arquivos comprimidos. Os serviços dos outros projetos mantêm suas
próprias configurações.
