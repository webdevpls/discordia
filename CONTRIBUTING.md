# Como contribuir

Obrigado pelo interesse! Issues, ideias e pull requests são bem-vindos.

## Antes de começar

- **Bug:** abra uma issue com o modelo "Bug", dizendo navegador, sistema e como reproduzir.
- **Funcionalidade nova:** abra uma issue com o modelo "Ideia" antes de escrever código, para combinarmos o caminho. O projeto busca ficar minimalista, e nem toda funcionalidade do Discord faz sentido aqui.
- **Falha de segurança:** **não** abra issue pública. Veja o [SECURITY.md](SECURITY.md).

## Rodando o projeto

```bash
cd frontend && npm install && cd ..
make dev    # backend :8080 + frontend http://localhost:5173
make test   # rode antes de abrir o PR
```

Requisitos: Go 1.27+ e Node 22+. Para testar chamadas, use duas janelas (uma anônima) e fone de ouvido.

Para simular internet ruim: `RTC_SIM_LOSS=0.12 make backend` descarta 12% dos pacotes de mídia.

## Estilo

- **Go:** `gofmt` e `go vet` limpos. Pacotes pequenos, sem frameworks; a biblioteca padrão primeiro.
- **Frontend:** TypeScript estrito, `npm run lint` limpo. Estado global no `store.ts` (zustand); WebRTC fica em `src/lib/rtc.ts`.
- **CSS:** use as variáveis de cor do `:root` (elas cobrem tema claro e escuro). Nada de cor fixa nos componentes.
- **Comentários** explicam o *porquê*, não o *o quê*.
- **Textos da interface** em português do Brasil, curtos e diretos.

## Pull requests

- Um assunto por PR, com uma descrição curta do que muda e de como você testou.
- Mudanças em chamadas (SFU, `rtc.ts`) precisam ser testadas com pelo menos duas pessoas na chamada.
- Ao contribuir, você concorda que sua contribuição será licenciada sob a [AGPL-3.0](LICENSE).
