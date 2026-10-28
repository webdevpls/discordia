package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"

	"discordia/internal/sfu"
	"discordia/internal/store"
)

// Event is the envelope for every gateway message, in both directions.
type Event struct {
	T string          `json:"t"`
	D json.RawMessage `json:"d,omitempty"`
}

type Hub struct {
	store   *store.Store
	sfu     *sfu.SFU
	origins []string

	mu      sync.RWMutex
	clients map[int64]map[*Client]struct{}
}

func NewHub(st *store.Store, sf *sfu.SFU, origins []string) *Hub {
	h := &Hub{store: st, sfu: sf, origins: origins, clients: map[int64]map[*Client]struct{}{}}
	sf.OnState = func(groupID, channelID int64, users []sfu.VoiceUser) {
		h.SendToGroup(groupID, "voice.state", map[string]any{"channel_id": channelID, "users": users})
	}
	return h
}

type Client struct {
	hub  *Hub
	user store.User
	conn *websocket.Conn
	send chan []byte

	mu    sync.Mutex
	voice *sfu.Participant
}

func encode(t string, d any) []byte {
	b, _ := json.Marshal(map[string]any{"t": t, "d": d})
	return b
}

func (c *Client) emit(t string, d any) { c.push(encode(t, d)) }

func (c *Client) push(b []byte) {
	select {
	case c.send <- b:
	default:
		// Slow consumer: drop it rather than stall everyone else.
		c.conn.Close(websocket.StatusPolicyViolation, "too slow")
	}
}

func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, user store.User) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins})
	if err != nil {
		return
	}
	conn.SetReadLimit(1 << 20) // SDP can be large-ish
	c := &Client{hub: h, user: user, conn: conn, send: make(chan []byte, 256)}

	first := h.register(c)
	if first {
		h.presence(user.ID, true)
	}
	c.emit("ready", h.readyPayload(user))

	ctx, cancel := context.WithCancel(r.Context())
	go c.writeLoop(ctx)
	c.readLoop(ctx)
	cancel()

	c.mu.Lock()
	p := c.voice
	c.voice = nil
	c.mu.Unlock()
	if p != nil {
		h.sfu.Leave(p)
	}
	if last := h.unregister(c); last {
		h.presence(user.ID, false)
	}
	conn.CloseNow()
}

func (h *Hub) register(c *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.clients[c.user.ID]
	if set == nil {
		set = map[*Client]struct{}{}
		h.clients[c.user.ID] = set
	}
	set[c] = struct{}{}
	return len(set) == 1
}

func (h *Hub) unregister(c *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.clients[c.user.ID]
	delete(set, c)
	if len(set) == 0 {
		delete(h.clients, c.user.ID)
		return true
	}
	return false
}

func (h *Hub) isOnline(id int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[id]) > 0
}

func (h *Hub) readyPayload(user store.User) map[string]any {
	online := []int64{}
	if peers, err := h.store.Peers(user.ID); err == nil {
		for _, id := range peers {
			if h.isOnline(id) {
				online = append(online, id)
			}
		}
	}
	voice := map[int64][]sfu.VoiceUser{}
	if groups, err := h.store.GroupIDsForUser(user.ID); err == nil {
		mine := map[int64]bool{}
		for _, g := range groups {
			mine[g] = true
		}
		for chID, users := range h.sfu.Snapshot() {
			if ch, err := h.store.Channel(chID); err == nil && mine[ch.GroupID] {
				voice[chID] = users
			}
		}
	}
	ice := h.sfu.ICEServers()
	if ice == nil {
		ice = []webrtc.ICEServer{}
	}
	return map[string]any{"user": user, "online": online, "voice": voice, "ice_servers": ice}
}

func (h *Hub) presence(userID int64, online bool) {
	peers, err := h.store.Peers(userID)
	if err != nil {
		return
	}
	h.SendToUsers(peers, "presence", map[string]any{"user_id": userID, "online": online})
}

func (h *Hub) SendToUsers(ids []int64, t string, d any) {
	b := encode(t, d)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, id := range ids {
		for c := range h.clients[id] {
			c.push(b)
		}
	}
}

func (h *Hub) SendToGroup(groupID int64, t string, d any) {
	ids, err := h.store.MemberIDs(groupID)
	if err != nil {
		log.Printf("hub: members of %d: %v", groupID, err)
		return
	}
	h.SendToUsers(ids, t, d)
}

func (c *Client) writeLoop(ctx context.Context) {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-c.send:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.conn.CloseNow()
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Ping(pctx)
			cancel()
			if err != nil {
				c.conn.CloseNow()
				return
			}
		}
	}
}

func (c *Client) readLoop(ctx context.Context) {
	for {
		_, b, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		var ev Event
		if json.Unmarshal(b, &ev) != nil {
			continue
		}
		c.handle(ev)
	}
}

func (c *Client) currentVoice() *sfu.Participant {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.voice
}

func (c *Client) handle(ev Event) {
	h := c.hub
	switch ev.T {
	case "voice.join":
		var d struct {
			ChannelID int64 `json:"channel_id"`
		}
		if json.Unmarshal(ev.D, &d) != nil {
			return
		}
		ch, err := h.store.Channel(d.ChannelID)
		if err != nil || ch.Kind != "voice" || !h.store.IsMember(ch.GroupID, c.user.ID) {
			c.emit("error", map[string]string{"message": "canal de voz indisponível"})
			return
		}
		if old := c.currentVoice(); old != nil {
			h.sfu.Leave(old)
		}
		var p *sfu.Participant
		signal := func(t string, d any) {
			if t == "voice.left" {
				c.mu.Lock()
				if c.voice == p {
					c.voice = nil
				}
				c.mu.Unlock()
			}
			c.emit(t, d)
		}
		p, err = h.sfu.Join(ch.GroupID, ch.ID, c.user.ID, signal)
		if err != nil {
			log.Printf("voice join: %v", err)
			c.emit("error", map[string]string{"message": "falha ao entrar na chamada"})
			return
		}
		c.mu.Lock()
		c.voice = p
		c.mu.Unlock()
		c.emit("voice.joined", map[string]any{"channel_id": ch.ID, "group_id": ch.GroupID})

	case "voice.leave":
		c.mu.Lock()
		p := c.voice
		c.voice = nil
		c.mu.Unlock()
		if p != nil {
			h.sfu.Leave(p)
			c.emit("voice.left", map[string]any{"channel_id": p.Room().ChannelID})
		}

	case "voice.flags":
		var d struct {
			Muted    bool `json:"muted"`
			Deafened bool `json:"deafened"`
		}
		if p := c.currentVoice(); p != nil && json.Unmarshal(ev.D, &d) == nil {
			p.SetFlags(d.Muted, d.Deafened)
		}

	case "rtc.pub.offer":
		var d struct {
			SDP     string                `json:"sdp"`
			Sources map[string]sfu.Source `json:"sources"`
		}
		if p := c.currentVoice(); p != nil && json.Unmarshal(ev.D, &d) == nil {
			if err := p.HandlePubOffer(d.SDP, d.Sources); err != nil {
				log.Printf("pub offer: %v", err)
			}
		}

	case "rtc.sub.answer":
		var d struct {
			SDP string `json:"sdp"`
		}
		if p := c.currentVoice(); p != nil && json.Unmarshal(ev.D, &d) == nil {
			if err := p.HandleSubAnswer(d.SDP); err != nil {
				log.Printf("sub answer: %v", err)
			}
		}

	case "rtc.sub.want":
		var d struct {
			Video []string `json:"video"`
		}
		if p := c.currentVoice(); p != nil && json.Unmarshal(ev.D, &d) == nil {
			p.WantVideo(d.Video)
		}

	case "rtc.pub.candidate", "rtc.sub.candidate":
		var cand webrtc.ICECandidateInit
		p := c.currentVoice()
		if p == nil || json.Unmarshal(ev.D, &cand) != nil {
			return
		}
		if ev.T == "rtc.pub.candidate" {
			_ = p.AddPubCandidate(cand)
		} else {
			_ = p.AddSubCandidate(cand)
		}

	case "typing":
		var d struct {
			ChannelID int64 `json:"channel_id"`
		}
		if json.Unmarshal(ev.D, &d) != nil {
			return
		}
		if ch, err := h.store.Channel(d.ChannelID); err == nil && h.store.IsMember(ch.GroupID, c.user.ID) {
			h.SendToGroup(ch.GroupID, "typing", map[string]any{"channel_id": ch.ID, "user": c.user})
		}
	}
}
