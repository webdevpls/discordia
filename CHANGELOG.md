# Changelog

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [versionamento semântico](https://semver.org/lang/pt-BR/).

## [0.1.0] - 2026-10-27

Primeira versão pública.

### Adicionado

- Grupos com convite por código, canais de texto e de voz, e lista de membros com presença online.
- Chat em tempo real com indicador de digitação, links clicáveis e histórico paginado.
- Chamadas de voz com SFU próprio em Go (Pion), usando uma única porta UDP.
- Câmera e compartilhamento de tela com áudio, com H.264 preferido (hardware) e VP8 de reserva.
- Cada pessoa só recebe os vídeos que aparecem na tela.
- Supressão de ruído com RNNoise, ligada por padrão.
- Adaptação automática à conexão fraca, com indicador de sinal.
- Volume por pessoa e por transmissão (botão direito ou ícone de ajustes no quadro).
- Escolha de microfone e de saída de áudio.
- Imagem Docker única e `compose.yaml` com HTTPS automático via Caddy.
- Ferramenta de teste de carga do SFU e script de medição WebRTC.

[0.1.0]: https://github.com/webdevpls/discordia/releases/tag/v0.1.0
