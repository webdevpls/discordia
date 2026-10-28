// loadtest simulates N participants in one voice channel against a running
// server: each publishes audio (+ optional video) and subscribes to everyone
// else. It reports delivery and the server process' CPU / memory.
//
//	go run ./cmd/loadtest -n 8 -video -d 30s
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var (
	base     = flag.String("url", "http://localhost:8080", "server url")
	n        = flag.Int("n", 4, "participants")
	video    = flag.Bool("video", true, "publish a 600 kbps camera too")
	duration = flag.Duration("d", 20*time.Second, "measurement window")
	pid      = flag.Int("pid", 0, "server pid to sample (default: whoever listens on :8080)")
)

type peer struct {
	id      int64
	token   string
	conn    *websocket.Conn
	wmu     sync.Mutex
	pub     *webrtc.PeerConnection
	sub     *webrtc.PeerConnection
	rxBytes atomic.Int64
	rxPkts  atomic.Int64
	tracks  atomic.Int32
}

func api(method, path, token string, body, out any) error {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, *base+"/api"+path, bytes.NewReader(b))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %d", method, path, res.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

func (p *peer) send(t string, d any) {
	b, _ := json.Marshal(map[string]any{"t": t, "d": d})
	p.wmu.Lock()
	defer p.wmu.Unlock()
	_ = p.conn.Write(context.Background(), websocket.MessageText, b)
}

func main() {
	flag.Parse()
	run := rand.IntN(1_000_000)

	peers := make([]*peer, *n)
	var invite string
	var groupID int64
	for i := range peers {
		var a struct {
			Token string
			User  struct{ ID int64 }
		}
		if err := api("POST", "/auth/register", "", map[string]string{"username": fmt.Sprintf("lt%d_%d", run, i), "password": "loadtest"}, &a); err != nil {
			log.Fatal(err)
		}
		peers[i] = &peer{id: a.User.ID, token: a.Token}
		if i == 0 {
			var g struct {
				ID         int64  `json:"id"`
				InviteCode string `json:"invite_code"`
			}
			if err := api("POST", "/groups", a.Token, map[string]string{"name": "loadtest"}, &g); err != nil {
				log.Fatal(err)
			}
			invite, groupID = g.InviteCode, g.ID
		} else if err := api("POST", "/groups/join", a.Token, map[string]string{"invite_code": invite}, nil); err != nil {
			log.Fatal(err)
		}
	}
	var detail struct {
		Channels []struct {
			ID   int64
			Kind string
		}
	}
	_ = api("GET", fmt.Sprintf("/groups/%d", groupID), peers[0].token, nil, &detail)
	var voiceID int64
	for _, c := range detail.Channels {
		if c.Kind == "voice" {
			voiceID = c.ID
		}
	}

	stop := make(chan struct{})
	for _, p := range peers {
		join(p, voiceID, stop)
	}

	want := int32((*n - 1) * 1)
	if *video {
		want *= 2
	}
	log.Printf("%d participantes entrando; aguardando %d tracks por pessoa…", *n, want)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		ok := true
		for _, p := range peers {
			if p.tracks.Load() < want {
				ok = false
			}
		}
		if ok {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	for i, p := range peers {
		if got := p.tracks.Load(); got < want {
			log.Printf("aviso: participante %d recebeu só %d/%d tracks", i, got, want)
		}
	}

	server := *pid
	if server == 0 {
		server = findServer()
	}
	for _, p := range peers {
		p.rxBytes.Store(0)
		p.rxPkts.Store(0)
	}
	cpu0 := cpuTime(server)
	start := time.Now()
	var rssMax int64
	for time.Since(start) < *duration {
		time.Sleep(time.Second)
		if r := rss(server); r > rssMax {
			rssMax = r
		}
	}
	elapsed := time.Since(start).Seconds()
	cpu := (cpuTime(server) - cpu0) / elapsed * 100
	close(stop)

	var rx, pk int64
	for _, p := range peers {
		rx += p.rxBytes.Load()
		pk += p.rxPkts.Load()
	}
	perPub := 50.0 // audio pps
	if *video {
		perPub += 72
	}
	expectedPkts := perPub * float64(*n-1) * float64(*n) * elapsed
	fmt.Printf("\n=== %d participantes, video=%v, %.0fs ===\n", *n, *video, elapsed)
	fmt.Printf("servidor: CPU %.1f%% de 1 núcleo · RAM pico %.1f MB\n", cpu, float64(rssMax)/1024)
	fmt.Printf("saída do SFU: %.2f Mbps no total · %.2f Mbps por participante\n", float64(rx)*8/elapsed/1e6, float64(rx)*8/elapsed/1e6/float64(*n))
	fmt.Printf("entrega: %.1f%% dos pacotes esperados\n", float64(pk)/expectedPkts*100)
}

func join(p *peer, voiceID int64, stop chan struct{}) {
	ctx := context.Background()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(*base, "http")+"/ws?token="+p.token, nil)
	if err != nil {
		log.Fatal(err)
	}
	conn.SetReadLimit(1 << 20)
	p.conn = conn
	p.pub, _ = webrtc.NewPeerConnection(webrtc.Configuration{})
	p.sub, _ = webrtc.NewPeerConnection(webrtc.Configuration{})
	p.pub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			p.send("rtc.pub.candidate", c.ToJSON())
		}
	})
	p.sub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			p.send("rtc.sub.candidate", c.ToJSON())
		}
	})
	p.sub.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		p.tracks.Add(1)
		buf := make([]byte, 1500)
		for {
			k, _, err := tr.Read(buf)
			if err != nil {
				return
			}
			p.rxBytes.Add(int64(k))
			p.rxPkts.Add(1)
		}
	})

	go func() {
		for {
			_, b, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var ev struct {
				T string
				D json.RawMessage
			}
			_ = json.Unmarshal(b, &ev)
			switch ev.T {
			case "rtc.pub.answer":
				var d struct{ SDP string }
				_ = json.Unmarshal(ev.D, &d)
				_ = p.pub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: d.SDP})
			case "rtc.pub.candidate":
				var c webrtc.ICECandidateInit
				_ = json.Unmarshal(ev.D, &c)
				_ = p.pub.AddICECandidate(c)
			case "rtc.sub.offer":
				var d struct{ SDP string }
				_ = json.Unmarshal(ev.D, &d)
				_ = p.sub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: d.SDP})
				ans, _ := p.sub.CreateAnswer(nil)
				_ = p.sub.SetLocalDescription(ans)
				p.send("rtc.sub.answer", map[string]string{"sdp": ans.SDP})
			case "rtc.sub.candidate":
				var c webrtc.ICECandidateInit
				_ = json.Unmarshal(ev.D, &c)
				_ = p.sub.AddICECandidate(c)
			}
		}
	}()

	p.send("voice.join", map[string]any{"channel_id": voiceID})
	time.Sleep(100 * time.Millisecond)

	mic, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "a", "s")
	tMic, _ := p.pub.AddTransceiverFromTrack(mic, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	sources := map[string]string{}
	var cam *webrtc.TrackLocalStaticRTP
	var tCam *webrtc.RTPTransceiver
	if *video {
		cam, _ = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "v", "s")
		tCam, _ = p.pub.AddTransceiverFromTrack(cam, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	}
	offer, _ := p.pub.CreateOffer(nil)
	_ = p.pub.SetLocalDescription(offer)
	sources[tMic.Mid()] = "mic"
	if tCam != nil {
		sources[tCam.Mid()] = "camera"
	}
	p.send("rtc.pub.offer", map[string]any{"sdp": offer.SDP, "sources": sources})

	// Opus ~32 kbps: 50 pps × 80 B. VP8 ~600 kbps: 24 fps × 3 pkts × ~1040 B.
	go pump(stop, mic, 20*time.Millisecond, 1, 80, 960)
	if cam != nil {
		go pump(stop, cam, time.Second/24, 3, 1040, 3750)
	}
}

func pump(stop chan struct{}, tr *webrtc.TrackLocalStaticRTP, every time.Duration, perTick, size int, tsStep uint32) {
	payload := make([]byte, size)
	payload[0] = 0x10
	var seq uint16
	var ts uint32
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
		}
		ts += tsStep
		for i := 0; i < perTick; i++ {
			seq++
			_ = tr.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: ts, Marker: i == perTick-1}, Payload: payload})
		}
	}
}

func findServer() int {
	out, err := exec.Command("lsof", "-t", "-sTCP:LISTEN", "-i", ":8080").Output()
	if err != nil {
		log.Fatal("servidor não encontrado na porta 8080; use -pid")
	}
	id, _ := strconv.Atoi(strings.Fields(string(out))[0])
	return id
}

// cpuTime returns accumulated CPU seconds of pid (from ps "time" column).
func cpuTime(pid int) float64 {
	out, _ := exec.Command("ps", "-o", "time=", "-p", strconv.Itoa(pid)).Output()
	s := strings.TrimSpace(string(out)) // [[dd-]hh:]mm:ss.cc
	var total float64
	for _, part := range strings.Split(s, ":") {
		v, _ := strconv.ParseFloat(part, 64)
		total = total*60 + v
	}
	return total
}

func rss(pid int) int64 {
	out, _ := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	v, _ := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	return v
}
