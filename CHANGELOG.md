# Changelog

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [versionamento semântico](https://semver.org/lang/pt-BR/).

## [0.2.0] - 2026-10-28

### Adicionado

- **App de Mac** (Tauri): leve, com cerca de 3 MB, usando o WebKit do próprio macOS. Na primeira abertura pergunta o endereço do servidor (dá para trocar pelo menu). Instalação com um comando: `curl -fsSL https://raw.githubusercontent.com/webdevpls/discordia/main/install.sh | bash`.
- Com duas ou mais telas compartilhadas, cada pessoa escolhe ver **lado a lado**, **uma embaixo da outra** ou em **grade**.

### Alterado

- O contorno de quem está falando agora é azul e aparece também por cima da webcam.

### Corrigido

- Depois de parar de compartilhar a tela (ou desligar a câmera), não dava para compartilhar de novo sem sair da chamada.
- Ao ligar a câmera depois de um tempo só com áudio, o app confundia o começo da transmissão com conexão fraca e mandava o vídeo em 180p.

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

[0.2.0]: https://github.com/webdevpls/discordia/releases/tag/v0.2.0
[0.1.0]: https://github.com/webdevpls/discordia/releases/tag/v0.1.0
