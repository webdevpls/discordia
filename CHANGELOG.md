# Changelog

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [versionamento semântico](https://semver.org/lang/pt-BR/).

## [0.4.0] - 2026-11-10

### Adicionado

- **Controles da chamada na barra de menu do Mac.** Durante uma chamada, o ícone do Discordia aparece na barra de menu (vermelho quando você está mudo ou sem som). Ao clicar, abre um painel com botões de microfone, som, câmera, tela e sair, e a lista de quem está na chamada. O painel fica aberto enquanto você liga e desliga as coisas, e só existe enquanto está aberto: fechado, não usa memória nem processador.
- **Aviso de atualização.** No app de Mac, a barra lateral mostra um aviso em destaque quando sai uma versão nova, com o botão para baixar.

## [0.3.1] - 2026-11-07

### Corrigido

- **App de Mac usava um núcleo inteiro do processador ao compartilhar a tela.** O Chromium codificava a tela em software (OpenH264); agora ela vai para o encoder de hardware do Mac (VideoToolbox), como a câmera. O servidor passou a negociar H.264 nível 4.0, o necessário para 1080p.

## [0.3.0] - 2026-10-29

### Adicionado

- **Seletor de tela no estilo Discord.** No app de Mac, o botão de compartilhar abre um modal próprio com miniaturas ao vivo das telas e janelas e a opção de mandar o som do computador junto, sem passar pela seleção do sistema. No navegador, o modal pergunta antes se é uma aba, uma janela ou a tela inteira e se vai com som; o Chrome abre a seleção dele já no tipo certo e com o som marcado.

### Alterado

- O app de Mac agora é feito em Electron (antes Tauri/WebKit). O WebKit não captura o som no compartilhamento de tela e não permite um seletor próprio. O download ficou maior (cerca de 100 MB).

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

[0.3.0]: https://github.com/webdevpls/discordia/releases/tag/v0.3.0
[0.2.0]: https://github.com/webdevpls/discordia/releases/tag/v0.2.0
[0.1.0]: https://github.com/webdevpls/discordia/releases/tag/v0.1.0
