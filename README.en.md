<p align="center">
  <img src="docs/logo.svg" width="96" alt="Discordia logo">
</p>

<h1 align="center">Discordia</h1>

<p align="center">
  <strong>Groups, chat, voice, camera and screen sharing on your own server.</strong><br>
  Minimal look, light on CPU and easy to host: one container, one command.
</p>

<p align="center"><sub>Built by <strong>Vision Tech</strong></sub></p>

<p align="center"><a href="README.md">Português</a> · <strong>English</strong></p>

<p align="center">
  <a href="https://github.com/webdevpls/discordia/actions/workflows/ci.yml"><img src="https://github.com/webdevpls/discordia/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/webdevpls/discordia/releases/latest"><img src="https://img.shields.io/github/v/release/webdevpls/discordia?color=7b7bff" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="AGPL-3.0 license"></a>
</p>

<p align="center">
  <img src="docs/chat.png" alt="Discordia chat" width="100%">
</p>

> The interface is currently in Brazilian Portuguese. Translations are a welcome contribution.

---

## Features

- **Groups** with invite codes, text and voice channels, and a member list with online presence.
- **Real-time chat** with typing indicators, clickable links and paginated history.
- **Voice calls** with a speaking indicator, mute and deafen.
- **Camera** and **screen sharing** (with tab audio).
- **AI noise suppression** ([RNNoise](https://github.com/xiph/rnnoise)), on by default: removes keyboards, fans and background noise.
- **Weak connection?** The app detects packet loss and latency, scales video down automatically and keeps voice prioritized. A signal indicator shows the connection quality.
- **Per-person and per-stream volume**: right-click any tile (or its settings icon) to change someone's or a shared screen's volume.
- **Microphone and audio output selection**, like Discord.
- Automatic **light and dark theme**, and a layout that works on phones.

<p align="center">
  <img src="docs/call.png" alt="Voice call" width="49%">
  <img src="docs/stream-menu.png" alt="Shared screen volume menu" width="49%">
</p>

## Self-hosting

You need a server with Docker (any 1 vCPU / 1 GB VPS is enough for small groups) and a domain pointing to it.

```bash
git clone https://github.com/webdevpls/discordia.git
cd discordia
cp .env.example .env    # set your DOMAIN and RTC_PUBLIC_IP
docker compose up -d
```

That's it: open `https://your-domain`. [Caddy](https://caddyserver.com) issues the HTTPS certificate automatically.

**Open in your firewall:** `80/tcp`, `443/tcp`, `443/udp` and **`7882/udp`**. Without 7882 the call connects but no audio or video flows.

> **No domain?** Use `<ip-with-dashes>.sslip.io` (e.g. `203-0-113-10.sslip.io`), which works with real HTTPS.
> HTTPS is required: browsers only allow camera and microphone on secure pages.

**Just trying it locally:** `docker compose up discordia` and open http://localhost:8080.

**Update:** `docker compose pull && docker compose up -d`.

**Backup:** everything lives in the `discordia-data` volume (a SQLite database).

## Configuration

`.env` variables:

| Variable          | Default                        | Purpose                                                    |
| ----------------- | ------------------------------ | ---------------------------------------------------------- |
| `DOMAIN`          | `localhost`                    | Server domain (used by Caddy and the origin check)         |
| `RTC_PUBLIC_IP`   | —                              | Server public IP. **Required on a VPS/cloud**              |
| `RTC_ICE_SERVERS` | `stun:stun.l.google.com:19302` | STUN/TURN servers handed to browsers, comma separated      |

Server variables, if you run the binary directly:

| Variable          | Default                   | Purpose                                                  |
| ----------------- | ------------------------- | -------------------------------------------------------- |
| `ADDR`            | `:8080`                   | HTTP address                                             |
| `DB_PATH`         | `discordia.db`            | SQLite file                                              |
| `RTC_UDP_PORT`    | `7882`                    | Single UDP port for all WebRTC traffic                   |
| `ALLOWED_ORIGINS` | `localhost:*,127.0.0.1:*` | Origins allowed on the WebSocket                         |
| `STATIC_DIR`      | —                         | Built frontend folder to serve alongside                 |
| `RTC_SIM_LOSS`    | `0`                       | **Testing only**: fraction of packets dropped on purpose |

## Development

Requirements: Go 1.27+ and Node 22+.

```bash
cd frontend && npm install && cd ..
make dev    # backend on :8080, frontend on http://localhost:5173
make test   # Go tests (with -race, including an SFU end-to-end test) + frontend build and lint
```

To test a call alone, open two windows (one private), create two accounts and use the invite code. Wear headphones to avoid echo.

## How it works

Calls go through an **SFU** (Selective Forwarding Unit) written in Go with [Pion](https://github.com/pion/webrtc):

- Each person sends their audio and video **once** to the server, which only **forwards** packets to the others, without decoding or re-encoding. The server does little more than copy packets, and each person's upload doesn't grow with the room size.
- Each participant uses two connections, one to send and one to receive, which avoids renegotiation conflicts when someone turns their camera on mid-call.
- All connections share **a single UDP port**, which keeps firewall rules simple.
- **H.264** is preferred (hardware-encoded and decoded on most computers and phones), with VP8 as a fallback.
- Each person only receives the videos **visible on screen**. A minimized tab, or one on a text channel, downloads and decodes no video at all, while audio keeps flowing.

## Performance

Measured with `backend/cmd/loadtest`, with every participant sending audio and camera:

| People in the call | Server CPU (1 core) | RAM    | Packets delivered |
| -----------------: | ------------------: | -----: | ----------------: |
| 4                  | 10%                 | 42 MB  | 100%              |
| 8                  | 24%                 | 84 MB  | 100%              |
| 12                 | 45%                 | 138 MB | 100%              |

Details, methodology and browser numbers in [docs/PERF.md](docs/PERF.md) (Portuguese).

## Privacy and security

- No telemetry, no tracking, no third-party services. The only external one is Google's STUN, used during calls just to discover the public IP, and you can replace it in `RTC_ICE_SERVERS`.
- Passwords are stored with bcrypt.
- Media is encrypted between the browser and the server (DTLS-SRTP), but it is **not end-to-end**: the server forwards the packets and could, in theory, access them. Host it on a server you trust.
- Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Limitations and roadmap

- **Simulcast:** each video is currently sent in a single quality. If the weak connection is on the receiving side, the app warns but can't scale the video down for that person alone.
- **TURN:** on very restrictive corporate networks calls may fail without a TURN server (e.g. [coturn](https://github.com/coturn/coturn)) in `RTC_ICE_SERVERS`.
- Not there yet: direct messages, file uploads, roles and permissions, message editing, native apps, interface translations.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License and trademark

The code is licensed under the [GNU Affero General Public License v3.0](LICENSE). In short: you may use, modify and host it freely, including commercially. If you offer a **modified** version for others to use over a network, you must make the source code of those modifications available.

The Discordia name and logo have their own rules: see [TRADEMARKS.md](TRADEMARKS.md).

Discordia is an independent project and **is not affiliated with Discord Inc.** "Discord" is a registered trademark of Discord Inc.
