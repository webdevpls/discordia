// Package store persists users, groups, channels and messages in SQLite.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

type Group struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	OwnerID    int64  `json:"owner_id"`
	InviteCode string `json:"invite_code"`
}

type Channel struct {
	ID      int64  `json:"id"`
	GroupID int64  `json:"group_id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // "text" | "voice"
}

type Message struct {
	ID        int64     `json:"id"`
	ChannelID int64     `json:"channel_id"`
	Author    User      `json:"author"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY,
	username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	owner_id INTEGER NOT NULL REFERENCES users(id),
	invite_code TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
	group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	joined_at INTEGER NOT NULL,
	PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS channels (
	id INTEGER PRIMARY KEY,
	group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('text','voice'))
);
CREATE INDEX IF NOT EXISTS channels_group ON channels(group_id);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY,
	channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id),
	content TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
`

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// SQLite serialises writers anyway; a single connection avoids SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func now() int64 { return time.Now().UnixMilli() }

// --- users & sessions ---

func (s *Store) CreateUser(username, hash string) (User, error) {
	res, err := s.db.Exec(`INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`, username, hash, now())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return User{}, ErrConflict
		}
		return User{}, err
	}
	id, _ := res.LastInsertId()
	return User{ID: id, Username: username}, nil
}

func (s *Store) UserByUsername(username string) (User, string, error) {
	var u User
	var hash string
	err := s.db.QueryRow(`SELECT id, username, password_hash FROM users WHERE username = ?`, username).Scan(&u.ID, &u.Username, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return u, "", ErrNotFound
	}
	return u, hash, err
}

func (s *Store) CreateSession(userID int64) (string, error) {
	token := randomToken(32)
	_, err := s.db.Exec(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`, token, userID, now())
	return token, err
}

func (s *Store) UserBySession(token string) (User, error) {
	var u User
	err := s.db.QueryRow(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token).Scan(&u.ID, &u.Username)
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	return u, err
}

func (s *Store) DeleteSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token = ?`, token)
	return err
}

// --- groups ---

func (s *Store) CreateGroup(name string, ownerID int64) (Group, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Group{}, err
	}
	defer tx.Rollback()

	g := Group{Name: name, OwnerID: ownerID, InviteCode: randomToken(4)}
	res, err := tx.Exec(`INSERT INTO groups (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)`, g.Name, g.OwnerID, g.InviteCode, now())
	if err != nil {
		return Group{}, err
	}
	g.ID, _ = res.LastInsertId()
	if _, err := tx.Exec(`INSERT INTO members (group_id, user_id, joined_at) VALUES (?, ?, ?)`, g.ID, ownerID, now()); err != nil {
		return Group{}, err
	}
	if _, err := tx.Exec(`INSERT INTO channels (group_id, name, kind) VALUES (?, 'geral', 'text'), (?, 'Geral', 'voice')`, g.ID, g.ID); err != nil {
		return Group{}, err
	}
	return g, tx.Commit()
}

func (s *Store) Group(id int64) (Group, error) {
	var g Group
	err := s.db.QueryRow(`SELECT id, name, owner_id, invite_code FROM groups WHERE id = ?`, id).Scan(&g.ID, &g.Name, &g.OwnerID, &g.InviteCode)
	if errors.Is(err, sql.ErrNoRows) {
		return g, ErrNotFound
	}
	return g, err
}

func (s *Store) GroupByInvite(code string) (Group, error) {
	var g Group
	err := s.db.QueryRow(`SELECT id, name, owner_id, invite_code FROM groups WHERE invite_code = ?`, code).Scan(&g.ID, &g.Name, &g.OwnerID, &g.InviteCode)
	if errors.Is(err, sql.ErrNoRows) {
		return g, ErrNotFound
	}
	return g, err
}

func (s *Store) GroupsForUser(userID int64) ([]Group, error) {
	rows, err := s.db.Query(`SELECT g.id, g.name, g.owner_id, g.invite_code FROM groups g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Group{}
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.Name, &g.OwnerID, &g.InviteCode); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// AddMember reports whether the user was newly added.
func (s *Store) AddMember(groupID, userID int64) (bool, error) {
	res, err := s.db.Exec(`INSERT OR IGNORE INTO members (group_id, user_id, joined_at) VALUES (?, ?, ?)`, groupID, userID, now())
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) RemoveMember(groupID, userID int64) error {
	_, err := s.db.Exec(`DELETE FROM members WHERE group_id = ? AND user_id = ?`, groupID, userID)
	return err
}

func (s *Store) IsMember(groupID, userID int64) bool {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM members WHERE group_id = ? AND user_id = ?`, groupID, userID).Scan(&one)
	return err == nil
}

func (s *Store) Members(groupID int64) ([]User, error) {
	rows, err := s.db.Query(`SELECT u.id, u.username FROM users u JOIN members m ON m.user_id = u.id WHERE m.group_id = ? ORDER BY u.username`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) MemberIDs(groupID int64) ([]int64, error) {
	return s.ids(`SELECT user_id FROM members WHERE group_id = ?`, groupID)
}

func (s *Store) GroupIDsForUser(userID int64) ([]int64, error) {
	return s.ids(`SELECT group_id FROM members WHERE user_id = ?`, userID)
}

// Peers returns every user that shares at least one group with userID.
func (s *Store) Peers(userID int64) ([]int64, error) {
	return s.ids(`SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m2.group_id = m1.group_id WHERE m1.user_id = ?`, userID)
}

func (s *Store) ids(query string, arg int64) ([]int64, error) {
	rows, err := s.db.Query(query, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// --- channels ---

func (s *Store) Channels(groupID int64) ([]Channel, error) {
	rows, err := s.db.Query(`SELECT id, group_id, name, kind FROM channels WHERE group_id = ? ORDER BY kind, id`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Channel{}
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.GroupID, &c.Name, &c.Kind); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) Channel(id int64) (Channel, error) {
	var c Channel
	err := s.db.QueryRow(`SELECT id, group_id, name, kind FROM channels WHERE id = ?`, id).Scan(&c.ID, &c.GroupID, &c.Name, &c.Kind)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

func (s *Store) CreateChannel(groupID int64, name, kind string) (Channel, error) {
	res, err := s.db.Exec(`INSERT INTO channels (group_id, name, kind) VALUES (?, ?, ?)`, groupID, name, kind)
	if err != nil {
		return Channel{}, err
	}
	id, _ := res.LastInsertId()
	return Channel{ID: id, GroupID: groupID, Name: name, Kind: kind}, nil
}

func (s *Store) DeleteChannel(id int64) error {
	_, err := s.db.Exec(`DELETE FROM channels WHERE id = ?`, id)
	return err
}

// --- messages ---

func (s *Store) CreateMessage(channelID int64, author User, content string) (Message, error) {
	t := time.Now()
	res, err := s.db.Exec(`INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)`, channelID, author.ID, content, t.UnixMilli())
	if err != nil {
		return Message{}, err
	}
	id, _ := res.LastInsertId()
	return Message{ID: id, ChannelID: channelID, Author: author, Content: content, CreatedAt: t}, nil
}

// Messages returns up to limit messages older than before (0 = latest), oldest first.
func (s *Store) Messages(channelID, before int64, limit int) ([]Message, error) {
	if before <= 0 {
		before = 1<<63 - 1
	}
	rows, err := s.db.Query(`
		SELECT m.id, m.channel_id, u.id, u.username, m.content, m.created_at
		FROM messages m JOIN users u ON u.id = m.user_id
		WHERE m.channel_id = ? AND m.id < ?
		ORDER BY m.id DESC LIMIT ?`, channelID, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		var ts int64
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.Author.ID, &m.Author.Username, &m.Content, &ts); err != nil {
			return nil, err
		}
		m.CreatedAt = time.UnixMilli(ts)
		out = append(out, m)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, rows.Err()
}
