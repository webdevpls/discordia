package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"discordia/internal/sfu"
	"discordia/internal/store"
)

func post(t *testing.T, url, token string, body any, out any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		t.Fatalf("POST %s: %d", url, res.StatusCode)
	}
	if out != nil {
		_ = json.NewDecoder(res.Body).Decode(out)
	}
}

// wsClient is a tiny gateway client that records events and drives a pion peer.
type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
	mu   sync.Mutex
	evs  chan Event
}

func dial(t *testing.T, base, token string) *wsClient {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws?token="+token, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &wsClient{t: t, conn: conn, evs: make(chan Event, 256)}
	go func() {
		for {
			_, b, err := conn.Read(context.Background())
			if err != nil {
				close(c.evs)
				return
			}
			var ev Event
			_ = json.Unmarshal(b, &ev)
			c.evs <- ev
		}
	}()
	return c
}

func (c *wsClient) send(typ string, d any) {
	b, _ := json.Marshal(map[string]any{"t": typ, "d": d})
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.Write(context.Background(), websocket.MessageText, b)
}

func TestVoiceForwarding(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	sf, err := sfu.New(sfu.Config{UDPPort: 17882})
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(st, sf, []string{"*"})
	ts := httptest.NewServer(New(st, hub, ""))
	defer ts.Close()

	type auth struct {
		Token string     `json:"token"`
		User  store.User `json:"user"`
	}
	var a, b auth
	post(t, ts.URL+"/api/auth/register", "", map[string]string{"username": "alice", "password": "secret1"}, &a)
	post(t, ts.URL+"/api/auth/register", "", map[string]string{"username": "bob", "password": "secret1"}, &b)
	var g store.Group
	post(t, ts.URL+"/api/groups", a.Token, map[string]string{"name": "Teste"}, &g)
	post(t, ts.URL+"/api/groups/join", b.Token, map[string]string{"invite_code": g.InviteCode}, nil)
	chans, _ := st.Channels(g.ID)
	var voiceID int64
	for _, c := range chans {
		if c.Kind == "voice" {
			voiceID = c.ID
		}
	}

	ca, cb := dial(t, ts.URL, a.Token), dial(t, ts.URL, b.Token)

	// Bob: subscriber side — answer every sub offer, report received tracks.
	got := make(chan string, 4)
	offers := make(chan string, 16)
	bobSub, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
	bobSub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			cb.send("rtc.sub.candidate", c.ToJSON())
		}
	})
	bobSub.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		buf := make([]byte, 1500)
		if _, _, err := tr.Read(buf); err == nil {
			got <- tr.StreamID()
		}
	})
	go func() {
		for ev := range cb.evs {
			switch ev.T {
			case "rtc.sub.offer":
				var d struct{ SDP string }
				_ = json.Unmarshal(ev.D, &d)
				_ = bobSub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: d.SDP})
				ans, _ := bobSub.CreateAnswer(nil)
				_ = bobSub.SetLocalDescription(ans)
				cb.send("rtc.sub.answer", map[string]string{"sdp": ans.SDP})
				offers <- d.SDP
			case "rtc.sub.candidate":
				var c webrtc.ICECandidateInit
				_ = json.Unmarshal(ev.D, &c)
				_ = bobSub.AddICECandidate(c)
			}
		}
	}()
	cb.send("voice.join", map[string]any{"channel_id": voiceID})

	// Alice: publisher with a mic and a camera track.
	alicePub, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
	mic, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "a", "s1")
	cam, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}, "v", "s2")
	tMic, _ := alicePub.AddTransceiverFromTrack(mic, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	tCam, _ := alicePub.AddTransceiverFromTrack(cam, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	alicePub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			ca.send("rtc.pub.candidate", c.ToJSON())
		}
	})
	stateSeen := make(chan sfu.VoiceUser, 16)
	go func() {
		for ev := range ca.evs {
			switch ev.T {
			case "rtc.pub.answer":
				var d struct{ SDP string }
				_ = json.Unmarshal(ev.D, &d)
				_ = alicePub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: d.SDP})
			case "rtc.pub.candidate":
				var c webrtc.ICECandidateInit
				_ = json.Unmarshal(ev.D, &c)
				_ = alicePub.AddICECandidate(c)
			case "voice.state":
				var d struct{ Users []sfu.VoiceUser }
				_ = json.Unmarshal(ev.D, &d)
				for _, u := range d.Users {
					if u.UserID == a.User.ID {
						stateSeen <- u
					}
				}
			}
		}
	}()
	ca.send("voice.join", map[string]any{"channel_id": voiceID})
	time.Sleep(200 * time.Millisecond)

	offer, _ := alicePub.CreateOffer(nil)
	_ = alicePub.SetLocalDescription(offer)
	ca.send("rtc.pub.offer", map[string]any{"sdp": offer.SDP, "sources": map[string]string{tMic.Mid(): "mic", tCam.Mid(): "camera"}})

	// Pump fake RTP until Bob has seen both tracks.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		var seq uint16
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			seq++
			for _, tr := range []*webrtc.TrackLocalStaticRTP{mic, cam} {
				_ = tr.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * 960}, Payload: []byte{0x10, 0, 0, 0}})
			}
		}
	}()

	want := map[string]bool{trackKeyFor(a.User.ID, "mic"): false, trackKeyFor(a.User.ID, "camera"): false}
	timeout := time.After(10 * time.Second)
	for remaining := len(want); remaining > 0; {
		select {
		case id := <-got:
			if seen, ok := want[id]; ok && !seen {
				want[id] = true
				remaining--
			}
		case <-timeout:
			t.Fatalf("bob did not receive alice's tracks: %v", want)
		}
	}

	// The server should advertise Alice's camera.
	deadline := time.After(3 * time.Second)
wait:
	for {
		select {
		case u := <-stateSeen:
			if u.Camera {
				break wait
			}
		case <-deadline:
			t.Fatal("voice.state never reported camera=true")
		}
	}

	// Bob hides every video: the server must stop sending it (video m-line no longer sendonly)
	// while keeping the audio.
	for len(offers) > 0 {
		<-offers
	}
	cb.send("rtc.sub.want", map[string]any{"video": []string{}})
	select {
	case sdp := <-offers:
		for _, m := range strings.Split(sdp, "m=")[1:] {
			sending := strings.Contains(m, "a=sendonly") || strings.Contains(m, "a=sendrecv")
			if strings.HasPrefix(m, "video") && sending {
				t.Fatal("video still forwarded after rtc.sub.want with no video")
			}
			if strings.HasPrefix(m, "audio") && !sending {
				t.Fatal("audio stopped after rtc.sub.want")
			}
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no renegotiation after rtc.sub.want")
	}
}

func trackKeyFor(id int64, src string) string {
	b, _ := json.Marshal(id)
	return string(b) + "|" + src
}
