# Desempenho

Medido em 26/10/2026 num Mac Apple Silicon, com servidor e clientes na mesma máquina.

## Servidor (SFU), `cd backend && go run ./cmd/loadtest -n N -d 15s`

Cada participante envia áudio (Opus, ~32 kbps) e câmera (VP8, ~600 kbps) e recebe de todos os outros.

| Pessoas | CPU do servidor | RAM pico | Saída do SFU | Download por pessoa | Pacotes entregues |
| ------: | --------------: | -------: | -----------: | ------------------: | ----------------: |
| 2       | 4%              | 33 MB    | 1,3 Mbps     | 0,6 Mbps            | 100%              |
| 4       | 10%             | 42 MB    | 7,7 Mbps     | 1,9 Mbps            | 100%              |
| 8       | 24%             | 84 MB    | 36 Mbps      | 4,5 Mbps            | 100%              |
| 12      | 45%             | 138 MB   | 85 Mbps      | 7,1 Mbps            | 100%              |

CPU em % de **um** núcleo. Reduzir o buffer de NACK de 1024 para 256 pacotes baixou a RAM com 12 pessoas de 331 MB para 138 MB.

## Cliente (Chrome), 3 pessoas com câmera

Chrome headless com câmera e microfone falsos, medido com `frontend/perf/webrtc-stats.js`.

| Métrica                | Discordia            | Google Meet |
| ---------------------- | -------------------- | ----------- |
| PeerConnections        | 2                    | ?           |
| Upload (áudio + vídeo) | ~235 kbps            | ?           |
| Download               | ~470 kbps            | ?           |
| Vídeo enviado          | 640x360 @ 20fps VP8  | ?           |
| Encode por frame       | 1,1 ms               | ?           |
| CPU do Chrome          | ~19% de 1 núcleo/aba | ?           |

A câmera falsa gera uma imagem simples, por isso o vídeo ficou em ~200 kbps. Com câmera real ele sobe até o limite de 600 kbps.
A coluna do Meet se preenche colando o mesmo script no DevTools antes de entrar numa chamada do Meet.

## Otimizações de CPU (26/10/2026)

1. **Só o vídeo visível é recebido.** O cliente avisa o servidor (`rtc.sub.want`) quais vídeos aparecem na tela, e o SFU deixa de repassar o resto. Uma aba em segundo plano ou num canal de texto não recebe nem decodifica vídeo, mas o áudio continua.
2. **H.264 preferido, VP8 como reserva.** No teste, o vídeo recebido foi decodificado no hardware (`VideoToolboxVideoDecoder`). O Chrome headless codificou em software (OpenH264). No Chrome normal do Mac, a codificação também costuma ir para o VideoToolbox, e o script de medição mostra isso na linha "Encoder".
3. **Câmera a 15fps e no máximo 500 kbps.**

Com 3 pessoas e câmera ligada, a CPU total do Chrome caiu de 57% para 46–49% de um núcleo. A rodada de 46% teve só uma aba visível recebendo vídeo, então ela já inclui o ganho do item 1.
