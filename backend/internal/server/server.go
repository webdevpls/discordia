// Package server exposes the REST API and the realtime gateway.
package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"

	"discordia/internal/store"
)

type Server struct {
	store *store.Store
	hub   *Hub
	mux   *http.ServeMux
}

// New wires the routes. staticDir, if set, serves the built frontend (SPA).
func New(st *store.Store, hub *Hub, staticDir string) *Server {
	s := &Server{store: st, hub: hub, mux: http.NewServeMux()}
	m := s.mux

	m.HandleFunc("POST /api/auth/register", s.register)
	m.HandleFunc("POST /api/auth/login", s.login)
	m.HandleFunc("POST /api/auth/logout", s.auth(s.logout))
	m.HandleFunc("GET /api/me", s.auth(s.me))

	m.HandleFunc("POST /api/groups", s.auth(s.createGroup))
	m.HandleFunc("POST /api/groups/join", s.auth(s.joinGroup))
	m.HandleFunc("GET /api/groups/{id}", s.auth(s.getGroup))
	m.HandleFunc("DELETE /api/groups/{id}/members/me", s.auth(s.leaveGroup))
	m.HandleFunc("POST /api/groups/{id}/channels", s.auth(s.createChannel))

	m.HandleFunc("DELETE /api/channels/{id}", s.auth(s.deleteChannel))
	m.HandleFunc("GET /api/channels/{id}/messages", s.auth(s.listMessages))
	m.HandleFunc("POST /api/channels/{id}/messages", s.auth(s.postMessage))

	m.HandleFunc("GET /ws", s.gateway)

	if staticDir != "" {
		m.Handle("/", spa(staticDir))
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// --- helpers ---

type authed func(w http.ResponseWriter, r *http.Request, u store.User)

func bearer(r *http.Request) string {
	if t, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return t
	}
	return r.URL.Query().Get("token") // websocket can't set headers
}

func (s *Server) auth(next authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, err := s.store.UserBySession(bearer(r))
		if err != nil {
			fail(w, http.StatusUnauthorized, "não autenticado")
			return
		}
		next(w, r, u)
	}
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	reply(w, status, map[string]string{"error": msg})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		fail(w, http.StatusBadRequest, "json inválido")
		return false
	}
	return true
}

func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}

func cleanName(s string, max int) (string, bool) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	return s, n > 0 && n <= max
}

// --- auth ---

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_.]{2,32}$`)

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decode(w, r, &c) {
		return
	}
	if !usernameRe.MatchString(c.Username) {
		fail(w, http.StatusBadRequest, "nome de usuário: 2–32 caracteres, letras, números, _ ou .")
		return
	}
	if len(c.Password) < 6 || len(c.Password) > 72 {
		fail(w, http.StatusBadRequest, "a senha precisa ter entre 6 e 72 caracteres")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	u, err := s.store.CreateUser(c.Username, string(hash))
	if errors.Is(err, store.ErrConflict) {
		fail(w, http.StatusConflict, "esse nome de usuário já existe")
		return
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	s.issueSession(w, u, http.StatusCreated)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decode(w, r, &c) {
		return
	}
	u, hash, err := s.store.UserByUsername(c.Username)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(c.Password)) != nil {
		fail(w, http.StatusUnauthorized, "usuário ou senha incorretos")
		return
	}
	s.issueSession(w, u, http.StatusOK)
}

func (s *Server) issueSession(w http.ResponseWriter, u store.User, status int) {
	token, err := s.store.CreateSession(u.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	reply(w, status, map[string]any{"token": token, "user": u})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, _ store.User) {
	_ = s.store.DeleteSession(bearer(r))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, _ *http.Request, u store.User) {
	groups, err := s.store.GroupsForUser(u.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	reply(w, http.StatusOK, map[string]any{"user": u, "groups": groups})
}

// --- groups ---

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request, u store.User) {
	var body struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	name, ok := cleanName(body.Name, 64)
	if !ok {
		fail(w, http.StatusBadRequest, "nome do grupo inválido")
		return
	}
	g, err := s.store.CreateGroup(name, u.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	reply(w, http.StatusCreated, g)
}

func (s *Server) joinGroup(w http.ResponseWriter, r *http.Request, u store.User) {
	var body struct {
		InviteCode string `json:"invite_code"`
	}
	if !decode(w, r, &body) {
		return
	}
	code := strings.TrimSpace(body.InviteCode)
	if i := strings.LastIndex(code, "/"); i >= 0 { // accept full invite links
		code = code[i+1:]
	}
	g, err := s.store.GroupByInvite(code)
	if err != nil {
		fail(w, http.StatusNotFound, "convite inválido")
		return
	}
	added, err := s.store.AddMember(g.ID, u.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	if added {
		s.hub.SendToGroup(g.ID, "member.join", map[string]any{"group_id": g.ID, "user": u, "online": true})
	}
	reply(w, http.StatusOK, g)
}

func (s *Server) memberGroup(w http.ResponseWriter, id int64, u store.User) (store.Group, bool) {
	g, err := s.store.Group(id)
	if err != nil || !s.store.IsMember(g.ID, u.ID) {
		fail(w, http.StatusNotFound, "grupo não encontrado")
		return g, false
	}
	return g, true
}

func (s *Server) getGroup(w http.ResponseWriter, r *http.Request, u store.User) {
	g, ok := s.memberGroup(w, pathID(r), u)
	if !ok {
		return
	}
	channels, err1 := s.store.Channels(g.ID)
	members, err2 := s.store.Members(g.ID)
	if err1 != nil || err2 != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	type member struct {
		store.User
		Online bool `json:"online"`
	}
	ms := make([]member, len(members))
	for i, m := range members {
		ms[i] = member{m, s.hub.isOnline(m.ID)}
	}
	reply(w, http.StatusOK, map[string]any{"group": g, "channels": channels, "members": ms})
}

func (s *Server) leaveGroup(w http.ResponseWriter, r *http.Request, u store.User) {
	g, ok := s.memberGroup(w, pathID(r), u)
	if !ok {
		return
	}
	if g.OwnerID == u.ID {
		fail(w, http.StatusBadRequest, "o dono não pode sair do próprio grupo")
		return
	}
	if err := s.store.RemoveMember(g.ID, u.ID); err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	s.hub.SendToGroup(g.ID, "member.leave", map[string]any{"group_id": g.ID, "user_id": u.ID})
	w.WriteHeader(http.StatusNoContent)
}

// --- channels ---

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request, u store.User) {
	g, ok := s.memberGroup(w, pathID(r), u)
	if !ok {
		return
	}
	if g.OwnerID != u.ID {
		fail(w, http.StatusForbidden, "apenas o dono pode criar canais")
		return
	}
	var body struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	}
	if !decode(w, r, &body) {
		return
	}
	name, ok := cleanName(body.Name, 48)
	if !ok || (body.Kind != "text" && body.Kind != "voice") {
		fail(w, http.StatusBadRequest, "canal inválido")
		return
	}
	if body.Kind == "text" {
		name = strings.ToLower(strings.Join(strings.Fields(name), "-"))
	}
	ch, err := s.store.CreateChannel(g.ID, name, body.Kind)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	s.hub.SendToGroup(g.ID, "channel.create", ch)
	reply(w, http.StatusCreated, ch)
}

// memberChannel loads a channel the user can see.
func (s *Server) memberChannel(w http.ResponseWriter, r *http.Request, u store.User) (store.Channel, bool) {
	ch, err := s.store.Channel(pathID(r))
	if err != nil || !s.store.IsMember(ch.GroupID, u.ID) {
		fail(w, http.StatusNotFound, "canal não encontrado")
		return ch, false
	}
	return ch, true
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request, u store.User) {
	ch, ok := s.memberChannel(w, r, u)
	if !ok {
		return
	}
	g, err := s.store.Group(ch.GroupID)
	if err != nil || g.OwnerID != u.ID {
		fail(w, http.StatusForbidden, "apenas o dono pode apagar canais")
		return
	}
	if err := s.store.DeleteChannel(ch.ID); err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	s.hub.SendToGroup(g.ID, "channel.delete", map[string]any{"id": ch.ID, "group_id": g.ID})
	w.WriteHeader(http.StatusNoContent)
}

// --- messages ---

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, u store.User) {
	ch, ok := s.memberChannel(w, r, u)
	if !ok {
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	msgs, err := s.store.Messages(ch.ID, before, 50)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	reply(w, http.StatusOK, msgs)
}

func (s *Server) postMessage(w http.ResponseWriter, r *http.Request, u store.User) {
	ch, ok := s.memberChannel(w, r, u)
	if !ok {
		return
	}
	if ch.Kind != "text" {
		fail(w, http.StatusBadRequest, "canal de voz não aceita mensagens")
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if !decode(w, r, &body) {
		return
	}
	content, ok := cleanName(body.Content, 2000)
	if !ok {
		fail(w, http.StatusBadRequest, "mensagem vazia ou longa demais")
		return
	}
	msg, err := s.store.CreateMessage(ch.ID, u, content)
	if err != nil {
		fail(w, http.StatusInternalServerError, "erro interno")
		return
	}
	s.hub.SendToGroup(ch.GroupID, "message.create", msg)
	reply(w, http.StatusCreated, msg)
}

// --- gateway & static ---

func (s *Server) gateway(w http.ResponseWriter, r *http.Request) {
	u, err := s.store.UserBySession(bearer(r))
	if err != nil {
		fail(w, http.StatusUnauthorized, "não autenticado")
		return
	}
	s.hub.Serve(w, r, u)
}

func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(filepath.Join(dir, filepath.Clean(r.URL.Path))); err != nil {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}
