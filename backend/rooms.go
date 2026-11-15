package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// roomPayload is what the browser reads and writes. Everything but revision is
// base64 so the payload survives JSON.
type roomPayload struct {
	SceneVersion int64  `json:"sceneVersion"`
	Ciphertext   string `json:"ciphertext"`
	IV           string `json:"iv"`
	Revision     int64  `json:"revision"`
	WriteToken   string `json:"writeToken,omitempty"`
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func tokenMatches(stored, presented []byte) bool {
	return len(stored) == len(presented) && subtle.ConstantTimeCompare(stored, presented) == 1
}

func (s *server) getRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("id")
	if !slugPattern.MatchString(roomID) {
		http.NotFound(w, r)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var (
		ciphertext, iv *[]byte
		sceneVersion   int64
		revision       int64
	)
	err := s.db.QueryRow(ctx,
		`UPDATE rooms SET last_accessed_at = now() WHERE room_id = $1
		 RETURNING ciphertext, iv, scene_version, revision`,
		roomID).Scan(&ciphertext, &iv, &sceneVersion, &revision)
	if errors.Is(err, pgx.ErrNoRows) || ciphertext == nil || iv == nil {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("get room: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "read failed"})
		return
	}

	writeJSON(w, http.StatusOK, roomPayload{
		SceneVersion: sceneVersion,
		Ciphertext:   base64.StdEncoding.EncodeToString(*ciphertext),
		IV:           base64.StdEncoding.EncodeToString(*iv),
		Revision:     revision,
	})
}

func (s *server) putRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("id")
	if !slugPattern.MatchString(roomID) {
		http.NotFound(w, r)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.maxBytes*2))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	var payload roomPayload
	if err := json.Unmarshal(body, &payload); err != nil || payload.WriteToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	ciphertext, err1 := base64.StdEncoding.DecodeString(payload.Ciphertext)
	iv, err2 := base64.StdEncoding.DecodeString(payload.IV)
	if err1 != nil || err2 != nil || len(ciphertext) == 0 || len(iv) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	presented := hashToken(payload.WriteToken)

	var (
		stored   []byte
		revision int64
		hasScene bool
	)
	err = tx.QueryRow(ctx,
		`SELECT token_hash, revision, ciphertext IS NOT NULL
		 FROM rooms WHERE room_id = $1 FOR UPDATE`,
		roomID).Scan(&stored, &revision, &hasScene)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// first writer claims the room; revision 0 is the only valid create
		if payload.Revision != 0 {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "revision"})
			return
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO rooms (room_id, token_hash, ciphertext, iv, revision, scene_version)
			 VALUES ($1, $2, $3, $4, 1, $5)`,
			roomID, presented, ciphertext, iv, payload.SceneVersion); err != nil {
			log.Printf("insert room: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
			return
		}
		if err := touchBoards(ctx, tx, roomID); err != nil {
			log.Printf("touch boards: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]int64{"revision": 1})
		return
	case err != nil:
		log.Printf("lock room: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}

	if !tokenMatches(stored, presented) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "wrong token"})
		return
	}
	// a room row can exist for image uploads before the first scene write
	if hasScene && payload.Revision != revision {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "revision", "revision": revision})
		return
	}

	var next int64
	if err := tx.QueryRow(ctx,
		`UPDATE rooms
		 SET ciphertext = $2, iv = $3, revision = revision + 1,
		     scene_version = $4, updated_at = now(), last_accessed_at = now()
		 WHERE room_id = $1
		 RETURNING revision`,
		roomID, ciphertext, iv, payload.SceneVersion).Scan(&next); err != nil {
		log.Printf("update room: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	if err := touchBoards(ctx, tx, roomID); err != nil {
		log.Printf("touch boards: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"revision": next})
}

// touchBoards keeps the gallery's "last edited" honest: the board row moves
// whenever its room is written, not only when the board is renamed.
func touchBoards(ctx context.Context, tx pgx.Tx, roomID string) error {
	_, err := tx.Exec(ctx,
		"UPDATE boards SET updated_at = now() WHERE room_id = $1", roomID)
	return err
}

// roomToken validates the header token against the stored hash and creates the
// room row when the first upload is an image.
func (s *server) roomToken(w http.ResponseWriter, r *http.Request, roomID string) bool {
	token := r.Header.Get("X-Room-Token")
	if token == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "missing token"})
		return false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	presented := hashToken(token)
	var stored []byte
	err := s.db.QueryRow(ctx, "SELECT token_hash FROM rooms WHERE room_id = $1", roomID).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = s.db.Exec(ctx,
			"INSERT INTO rooms (room_id, token_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			roomID, presented)
		if err != nil {
			log.Printf("claim room: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
			return false
		}
		return true
	}
	if err != nil {
		log.Printf("read room token: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return false
	}
	if !tokenMatches(stored, presented) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "wrong token"})
		return false
	}
	return true
}

func (s *server) putRoomFile(w http.ResponseWriter, r *http.Request) {
	roomID, fileID := r.PathValue("id"), r.PathValue("fileId")
	if !slugPattern.MatchString(roomID) || !filePattern.MatchString(fileID) {
		http.NotFound(w, r)
		return
	}
	if !s.limiter.allow(clientIP(r), time.Now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many uploads"})
		return
	}
	if !s.roomToken(w, r, roomID) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.maxBytes))
	if err != nil || len(body) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	_, err = s.db.Exec(ctx,
		`INSERT INTO room_files (room_id, file_id, payload) VALUES ($1, $2, $3)
		 ON CONFLICT (room_id, file_id) DO UPDATE SET payload = EXCLUDED.payload`,
		roomID, fileID, body)
	if err != nil {
		log.Printf("insert room file: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) getRoomFile(w http.ResponseWriter, r *http.Request) {
	roomID, fileID := r.PathValue("id"), r.PathValue("fileId")
	if !slugPattern.MatchString(roomID) || !filePattern.MatchString(fileID) {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var payload []byte
	err := s.db.QueryRow(ctx,
		"SELECT payload FROM room_files WHERE room_id = $1 AND file_id = $2",
		roomID, fileID).Scan(&payload)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	writeBlob(w, payload)
}
