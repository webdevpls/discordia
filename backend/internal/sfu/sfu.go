// Package sfu is a minimal Selective Forwarding Unit built on Pion.
//
// Each participant holds two PeerConnections: "pub" (browser offers, server
// receives its mic/camera/screen) and "sub" (server offers, browser receives
// everyone else's tracks). Splitting them removes offer glare and keeps the
// negotiation logic trivial. RTP is forwarded as-is — no transcoding — so the
// server cost is essentially packet copying.
package sfu

import (
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/webrtc/v4"
)

type Source string

const (
	SourceMic         Source = "mic"
	SourceCamera      Source = "camera"
	SourceScreen      Source = "screen"
	SourceScreenAudio Source = "screen-audio"
)

func validSource(s Source) bool {
	switch s {
	case SourceMic, SourceCamera, SourceScreen, SourceScreenAudio:
		return true
	}
	return false
}

// VoiceUser is the public state of someone in a voice channel.
type VoiceUser struct {
	UserID   int64 `json:"user_id"`
	Muted    bool  `json:"muted"`
	Deafened bool  `json:"deafened"`
	Camera   bool  `json:"camera"`
	Screen   bool  `json:"screen"`
}

// Signal delivers a signalling event to the participant's websocket.
type Signal func(t string, d any)

type Config struct {
	UDPPort    int      // single UDP port shared by every PeerConnection
	PublicIPs  []string // announced instead of host IPs (servers behind NAT)
	ICEServers []string // STUN/TURN urls handed to the browsers
	SimLoss    float64  // dev only: fraction of forwarded packets to drop (tests weak-connection handling)
}

type SFU struct {
	api        *webrtc.API
	iceServers []webrtc.ICEServer
	simLoss    float64

	mu     sync.Mutex
	rooms  map[int64]*Room        // by channel id
	byUser map[int64]*Participant // a user is in at most one voice channel

	// OnState fires whenever the participant list of a channel changes.
	OnState func(groupID, channelID int64, users []VoiceUser)
}

func New(cfg Config) (*SFU, error) {
	m := &webrtc.MediaEngine{}
	// Opus for audio. Video: H.264 Constrained Baseline first (hardware encode/decode
	// on Macs, most GPUs and phones), VP8 as fallback. Both are supported by every
	// major browser, so any publisher's track can be forwarded to any subscriber.
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	videoFB := []webrtc.RTCPFeedback{{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"}, {Type: "nack"}, {Type: "nack", Parameter: "pli"}}
	for _, c := range []webrtc.RTPCodecParameters{
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", RTCPFeedback: videoFB}, PayloadType: 102},
		{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: videoFB}, PayloadType: 96},
	} {
		if err := m.RegisterCodec(c, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
	}

	// Only the interceptors we need (skip the stats one to save CPU).
	ir := &interceptor.Registry{}
	// 256 packets ≈ 3.5s of 600 kbps video — plenty for retransmits, and 4× less
	// memory than the default 1024 (this buffer exists per stream per subscriber).
	if err := webrtc.ConfigureNackWithOptions(m, ir, nil, nack.ResponderSize(256)); err != nil {
		return nil, err
	}
	if err := webrtc.ConfigureRTCPReports(ir); err != nil {
		return nil, err
	}
	if err := webrtc.ConfigureTWCCSender(m, ir); err != nil {
		return nil, err
	}

	se := webrtc.SettingEngine{}
	mux, err := ice.NewMultiUDPMuxFromPort(cfg.UDPPort)
	if err != nil {
		return nil, fmt.Errorf("udp mux on :%d: %w", cfg.UDPPort, err)
	}
	se.SetICEUDPMux(mux)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	if len(cfg.PublicIPs) > 0 {
		se.SetNAT1To1IPs(cfg.PublicIPs, webrtc.ICECandidateTypeHost)
	}

	s := &SFU{
		api:     webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se)),
		rooms:   map[int64]*Room{},
		byUser:  map[int64]*Participant{},
		simLoss: cfg.SimLoss,
	}
	if len(cfg.ICEServers) > 0 {
		s.iceServers = []webrtc.ICEServer{{URLs: cfg.ICEServers}}
	}
	return s, nil
}

// ICEServers is what the browser should use for its own PeerConnections.
func (s *SFU) ICEServers() []webrtc.ICEServer { return s.iceServers }

// Join puts userID in a channel. Any previous voice session of the same user
// (another tab, another channel) is closed and its signal receives "voice.left".
func (s *SFU) Join(groupID, channelID, userID int64, signal Signal) (*Participant, error) {
	if old := s.Participant(userID); old != nil {
		s.Leave(old)
		old.signal("voice.left", map[string]any{"channel_id": old.room.ChannelID})
	}

	p := &Participant{
		UserID:     userID,
		sfu:        s,
		signal:     signal,
		midSources: map[string]Source{},
		fwdByMid:   map[string]*forwarder{},
		senders:    map[string]*webrtc.RTPSender{},
	}
	cfg := webrtc.Configuration{ICEServers: s.iceServers}
	var err error
	if p.pub, err = s.api.NewPeerConnection(cfg); err != nil {
		return nil, err
	}
	if p.sub, err = s.api.NewPeerConnection(cfg); err != nil {
		p.pub.Close()
		return nil, err
	}
	p.wire()

	s.mu.Lock()
	room := s.rooms[channelID]
	if room == nil {
		room = &Room{ChannelID: channelID, GroupID: groupID, sfu: s, participants: map[int64]*Participant{}, tracks: map[string]*forwarder{}}
		s.rooms[channelID] = room
	}
	p.room = room
	s.byUser[userID] = p
	s.mu.Unlock()

	room.add(p)
	go p.syncSubscriptions()
	return p, nil
}

func (s *SFU) Participant(userID int64) *Participant {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byUser[userID]
}

func (s *SFU) Leave(p *Participant) {
	s.mu.Lock()
	if s.byUser[p.UserID] == p {
		delete(s.byUser, p.UserID)
	}
	s.mu.Unlock()

	if !p.close() {
		return
	}
	p.room.remove(p)

	s.mu.Lock()
	if p.room.empty() && s.rooms[p.room.ChannelID] == p.room {
		delete(s.rooms, p.room.ChannelID)
	}
	s.mu.Unlock()
}

// Snapshot returns the participants of every active channel, keyed by channel id.
func (s *SFU) Snapshot() map[int64][]VoiceUser {
	s.mu.Lock()
	rooms := make([]*Room, 0, len(s.rooms))
	for _, r := range s.rooms {
		rooms = append(rooms, r)
	}
	s.mu.Unlock()
	out := make(map[int64][]VoiceUser, len(rooms))
	for _, r := range rooms {
		if users := r.state(); len(users) > 0 {
			out[r.ChannelID] = users
		}
	}
	return out
}

// --- room ---

type Room struct {
	ChannelID int64
	GroupID   int64
	sfu       *SFU

	mu           sync.Mutex
	participants map[int64]*Participant
	order        []int64
	tracks       map[string]*forwarder // published tracks by key "uid|source"
}

func (r *Room) add(p *Participant) {
	r.mu.Lock()
	r.participants[p.UserID] = p
	r.order = append(r.order, p.UserID)
	r.mu.Unlock()
	r.emitState()
}

func (r *Room) remove(p *Participant) {
	r.mu.Lock()
	if r.participants[p.UserID] == p {
		delete(r.participants, p.UserID)
		for i, id := range r.order {
			if id == p.UserID {
				r.order = append(r.order[:i], r.order[i+1:]...)
				break
			}
		}
	}
	for k, f := range r.tracks {
		if f.owner == p {
			delete(r.tracks, k)
		}
	}
	r.mu.Unlock()
	r.syncAll(p)
	r.emitState()
}

func (r *Room) empty() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.participants) == 0
}

func (r *Room) publish(f *forwarder) {
	r.mu.Lock()
	if r.participants[f.owner.UserID] != f.owner {
		r.mu.Unlock()
		return
	}
	r.tracks[f.key] = f
	r.mu.Unlock()
	r.syncAll(f.owner)
	r.emitState()
}

func (r *Room) unpublish(f *forwarder) {
	r.mu.Lock()
	if r.tracks[f.key] != f {
		r.mu.Unlock()
		return
	}
	delete(r.tracks, f.key)
	r.mu.Unlock()
	r.syncAll(f.owner)
	r.emitState()
}

// tracksFor returns every published track except the ones owned by p.
func (r *Room) tracksFor(p *Participant) map[string]*forwarder {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]*forwarder, len(r.tracks))
	for k, f := range r.tracks {
		if f.owner != p {
			out[k] = f
		}
	}
	return out
}

func (r *Room) syncAll(except *Participant) {
	r.mu.Lock()
	ps := make([]*Participant, 0, len(r.participants))
	for _, p := range r.participants {
		if p != except {
			ps = append(ps, p)
		}
	}
	r.mu.Unlock()
	for _, p := range ps {
		go p.syncSubscriptions()
	}
}

func (r *Room) state() []VoiceUser {
	r.mu.Lock()
	defer r.mu.Unlock()
	users := make([]VoiceUser, 0, len(r.order))
	for _, id := range r.order {
		p := r.participants[id]
		muted, deafened := p.flags()
		_, cam := r.tracks[trackKey(id, SourceCamera)]
		_, scr := r.tracks[trackKey(id, SourceScreen)]
		users = append(users, VoiceUser{UserID: id, Muted: muted, Deafened: deafened, Camera: cam, Screen: scr})
	}
	return users
}

func (r *Room) emitState() {
	if cb := r.sfu.OnState; cb != nil {
		cb(r.GroupID, r.ChannelID, r.state())
	}
}

func trackKey(userID int64, src Source) string { return fmt.Sprintf("%d|%s", userID, src) }

// --- participant ---

type Participant struct {
	UserID int64
	room   *Room
	sfu    *SFU
	signal Signal
	pub    *webrtc.PeerConnection
	sub    *webrtc.PeerConnection

	mu          sync.Mutex
	closed      bool
	muted       bool
	deafened    bool
	midSources  map[string]Source            // mids the browser is currently sending
	fwdByMid    map[string]*forwarder        // every incoming track, active or not
	senders     map[string]*webrtc.RTPSender // subscribed track key -> sender on p.sub
	videoWant   map[string]bool              // video keys the client shows; nil = all
	negotiating bool
	pending     bool
}

func (p *Participant) Room() *Room { return p.room }

// WantVideo limits which video tracks are forwarded to p (audio always flows).
// Clients send the tiles they actually render, so hidden videos cost nothing
// on either side: no bandwidth, no decoding.
func (p *Participant) WantVideo(keys []string) {
	want := make(map[string]bool, len(keys))
	for _, k := range keys {
		want[k] = true
	}
	p.mu.Lock()
	p.videoWant = want
	p.mu.Unlock()
	p.syncSubscriptions()
}

func (p *Participant) flags() (bool, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.muted, p.deafened
}

func (p *Participant) SetFlags(muted, deafened bool) {
	p.mu.Lock()
	p.muted, p.deafened = muted, deafened
	p.mu.Unlock()
	p.room.emitState()
}

func (p *Participant) wire() {
	p.pub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			p.signal("rtc.pub.candidate", c.ToJSON())
		}
	})
	p.sub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			p.signal("rtc.sub.candidate", c.ToJSON())
		}
	})
	p.pub.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed {
			p.sfu.Leave(p)
			p.signal("voice.left", map[string]any{"channel_id": p.room.ChannelID, "reason": "connection failed"})
		}
	})
	p.pub.OnTrack(p.onTrack)
}

// close reports false if the participant was already closed.
func (p *Participant) close() bool {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return false
	}
	p.closed = true
	p.mu.Unlock()
	// Close outside the lock: Pion may fire callbacks that need it.
	_ = p.pub.Close()
	_ = p.sub.Close()
	return true
}

// HandlePubOffer applies the browser's publish offer. sources maps each
// transceiver mid to what it carries; mids missing from it are paused.
func (p *Participant) HandlePubOffer(sdp string, sources map[string]Source) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return errors.New("closed")
	}
	p.midSources = map[string]Source{}
	for mid, src := range sources {
		if validSource(src) {
			p.midSources[mid] = src
		}
	}
	p.mu.Unlock()

	if err := p.pub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	answer, err := p.pub.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := p.pub.SetLocalDescription(answer); err != nil {
		return err
	}
	p.signal("rtc.pub.answer", map[string]string{"sdp": answer.SDP})

	// Resume / pause tracks whose transceivers already exist.
	p.mu.Lock()
	var toPublish, toUnpublish []*forwarder
	for mid, f := range p.fwdByMid {
		if src, ok := p.midSources[mid]; ok && src == f.source {
			toPublish = append(toPublish, f)
		} else {
			toUnpublish = append(toUnpublish, f)
		}
	}
	p.mu.Unlock()
	for _, f := range toUnpublish {
		p.room.unpublish(f)
	}
	for _, f := range toPublish {
		p.room.publish(f)
		f.requestKeyframe()
	}
	return nil
}

func (p *Participant) AddPubCandidate(c webrtc.ICECandidateInit) error {
	return p.pub.AddICECandidate(c)
}
func (p *Participant) AddSubCandidate(c webrtc.ICECandidateInit) error {
	return p.sub.AddICECandidate(c)
}

func (p *Participant) onTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	var mid string
	for _, t := range p.pub.GetTransceivers() {
		if t.Receiver() == receiver {
			mid = t.Mid()
			break
		}
	}

	p.mu.Lock()
	src, active := p.midSources[mid]
	if !active {
		src = SourceMic
		if remote.Kind() == webrtc.RTPCodecTypeVideo {
			src = SourceCamera
		}
	}
	key := trackKey(p.UserID, src)
	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, string(src), key)
	if err != nil {
		p.mu.Unlock()
		log.Printf("sfu: new local track: %v", err)
		return
	}
	f := &forwarder{key: key, owner: p, source: src, remote: remote, local: local}
	p.fwdByMid[mid] = f
	p.mu.Unlock()

	if active {
		p.room.publish(f)
	}

	buf := make([]byte, 1500)
	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			break
		}
		if p.sfu.simLoss > 0 && rand.Float64() < p.sfu.simLoss {
			continue
		}
		// Write fans the packet out to every subscriber bound to this track.
		if _, err := local.Write(buf[:n]); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			break
		}
	}

	p.mu.Lock()
	if p.fwdByMid[mid] == f {
		delete(p.fwdByMid, mid)
	}
	p.mu.Unlock()
	p.room.unpublish(f)
}

// syncSubscriptions makes p.sub carry exactly the room's tracks (minus p's own)
// and renegotiates if anything changed.
func (p *Participant) syncSubscriptions() {
	want := p.room.tracksFor(p)

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	if p.videoWant != nil {
		for key, f := range want {
			if f.local.Kind() == webrtc.RTPCodecTypeVideo && !p.videoWant[key] {
				delete(want, key)
			}
		}
	}
	changed := false
	for key, sender := range p.senders {
		if _, ok := want[key]; !ok {
			_ = p.sub.RemoveTrack(sender)
			delete(p.senders, key)
			changed = true
		}
	}
	for key, f := range want {
		if _, ok := p.senders[key]; ok {
			continue
		}
		sender, err := p.sub.AddTrack(f.local)
		if err != nil {
			log.Printf("sfu: add track %s: %v", key, err)
			continue
		}
		p.senders[key] = sender
		changed = true
		go readRTCP(sender, f)
	}
	if changed {
		p.negotiateLocked()
	}
}

func (p *Participant) negotiateLocked() {
	if p.negotiating || p.sub.SignalingState() != webrtc.SignalingStateStable {
		p.pending = true
		return
	}
	if len(p.sub.GetTransceivers()) == 0 {
		return
	}
	offer, err := p.sub.CreateOffer(nil)
	if err != nil {
		log.Printf("sfu: create offer: %v", err)
		return
	}
	if err := p.sub.SetLocalDescription(offer); err != nil {
		log.Printf("sfu: set local: %v", err)
		return
	}
	p.negotiating = true
	p.signal("rtc.sub.offer", map[string]string{"sdp": offer.SDP})
}

func (p *Participant) HandleSubAnswer(sdp string) error {
	p.mu.Lock()
	err := p.sub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
	p.negotiating = false
	if p.pending {
		p.pending = false
		p.negotiateLocked()
	}
	p.mu.Unlock()

	// New subscribers need a keyframe to start decoding.
	for _, f := range p.room.tracksFor(p) {
		f.requestKeyframe()
	}
	return err
}

// --- forwarder ---

type forwarder struct {
	key    string
	owner  *Participant
	source Source
	remote *webrtc.TrackRemote
	local  *webrtc.TrackLocalStaticRTP

	mu      sync.Mutex
	lastPLI time.Time
}

// requestKeyframe asks the publisher for a keyframe, at most twice a second.
func (f *forwarder) requestKeyframe() {
	if f.remote.Kind() != webrtc.RTPCodecTypeVideo {
		return
	}
	f.mu.Lock()
	if time.Since(f.lastPLI) < 500*time.Millisecond {
		f.mu.Unlock()
		return
	}
	f.lastPLI = time.Now()
	f.mu.Unlock()
	_ = f.owner.pub.WriteRTCP(pliFor(uint32(f.remote.SSRC())))
}

// readRTCP drains subscriber feedback (required for interceptors) and relays
// keyframe requests to the publisher.
func readRTCP(sender *webrtc.RTPSender, f *forwarder) {
	for {
		pkts, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		if wantsKeyframe(pkts) {
			f.requestKeyframe()
		}
	}
}
