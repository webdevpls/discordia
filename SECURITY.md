# Segurança

## Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Reporte em privado pelo GitHub:
[Security → Report a vulnerability](https://github.com/webdevpls/discordia/security/advisories/new).

Inclua o que conseguir: o tipo do problema, como reproduzir e o impacto que você enxerga. Respondemos o mais rápido possível, combinamos um prazo para a correção e damos o crédito a você na release (se você quiser).

## Versões com suporte

Só a versão mais recente recebe correções de segurança.

## O que esperar do modelo de segurança

- A mídia das chamadas é criptografada entre o navegador e o servidor (DTLS-SRTP), mas **não é de ponta a ponta**: quem administra o servidor pode, em tese, acessá-la.
- Mensagens ficam guardadas sem criptografia no banco do servidor.
- Quem tem o código de convite de um grupo pode entrar nele.
