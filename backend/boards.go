package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// A board is a private document: the gallery, the scene and its images all sit
// behind oauth2-proxy. Sharing is a separate, explicit action.
type boardSummary struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	FolderID   string     `json:"folderId"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	HasPreview bool       `json:"hasPreview"`
	Favorite   bool       `json:"favorite"`
	DeletedAt  *time.Time `json:"deletedAt"`
}

// createdBoard also carries the key a new board needs so the client can seed a
// template before the first editor session.
type createdBoard struct {
	boardSummary
	RoomKey string `json:"roomKey"`
}

type folderSummary struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type galleryResponse struct {
	Folders []folderSummary `json:"folders"`
	Boards  []boardSummary  `json:"boards"`
}

type boardScene struct {
	Ciphertext   string `json:"ciphertext"`
	IV           string `json:"iv"`
	Revision     int64  `json:"revision"`
	SceneVersion int64  `json:"sceneVersion"`
	RoomKey      string `json:"roomKey"`
	RoomID       string `json:"roomId"`
	Name         string `json:"name"`
}

// requireOwner refuses anything that did not come through oauth2-proxy. The
// public gateway only reaches these handlers for the private paths, and the
// proxy is the only caller that sets the header.
//
// In reverse-proxy mode the proxy forwards X-Forwarded-Email (because
// --pass-user-headers defaults to true). X-Auth-Request-Email only appears in
// nginx auth_request mode, and is accepted for that case.
func (s *server) requireOwner(w http.ResponseWriter, r *http.Request) bool {
	for _, header := range []string{"X-Forwarded-Email", "X-Auth-Request-Email"} {
		if strings.TrimSpace(r.Header.Get(header)) != "" {
			return true
		}
	}
	// Name the headers that did arrive, once, so a proxy that forwards a
	// different header than expected is one log line away from being obvious.
	missingHeaderOnce.Do(func() {
		names := make([]string, 0, len(r.Header))
		for name := range r.Header {
			names = append(names, name)
		}
		sort.Strings(names)
		log.Printf("boards request without an identity header, saw: %s", strings.Join(names, ", "))
	})
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
	return false
}

var missingHeaderOnce sync.Once

// boardRoomToken is the write token the collaboration client derives from a
// room key. Storing its hash lets a board room also accept collaborative
// writes, not just board autosaves.
func boardRoomToken(roomKey string) string {
	sum := sha256.Sum256([]byte(roomKey))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func decodeJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return false
	}
	if len(body) == 0 {
		return true
	}
	if err := json.Unmarshal(body, into); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return false
	}
	return true
}

func (s *server) listBoards(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Trashed boards are purged a month after deletion. Rooms are shared with
	// collaboration, so only drop the ones no board points at any more.
	if _, err := s.db.Exec(ctx,
		`WITH purged AS (
		   DELETE FROM boards WHERE deleted_at < now() - interval '30 days' RETURNING room_id
		 )
		 DELETE FROM rooms r WHERE r.room_id IN (SELECT room_id FROM purged)
		   AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.room_id = r.room_id)`); err != nil {
		log.Printf("purge trashed boards: %v", err)
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, name, coalesce(folder_id, ''), updated_at, preview IS NOT NULL,
		        favorite, deleted_at
		 FROM boards ORDER BY deleted_at NULLS FIRST, favorite DESC, updated_at DESC`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "gallery unavailable"})
		return
	}
	defer rows.Close()

	boards := []boardSummary{}
	for rows.Next() {
		var b boardSummary
		if err := rows.Scan(&b.ID, &b.Name, &b.FolderID, &b.UpdatedAt, &b.HasPreview,
			&b.Favorite, &b.DeletedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "gallery unavailable"})
			return
		}
		boards = append(boards, b)
	}
	if rows.Err() != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "gallery unavailable"})
		return
	}

	folderRows, err := s.db.Query(ctx, "SELECT id, name FROM folders ORDER BY lower(name)")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "gallery unavailable"})
		return
	}
	defer folderRows.Close()

	folders := []folderSummary{}
	for folderRows.Next() {
		var f folderSummary
		if err := folderRows.Scan(&f.ID, &f.Name); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "gallery unavailable"})
			return
		}
		folders = append(folders, f)
	}

	writeJSON(w, http.StatusOK, galleryResponse{Folders: folders, Boards: boards})
}

func (s *server) createBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	var req struct {
		Name     string `json:"name"`
		FolderID string `json:"folderId"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Untitled board"
	}

	boardID := newSlug(8)
	roomID := newSlug(10)
	roomKey := newSlug(16)

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var folder any
	if strings.TrimSpace(req.FolderID) != "" {
		folder = strings.TrimSpace(req.FolderID)
	}
	var created time.Time
	if err := s.db.QueryRow(ctx,
		`INSERT INTO boards (id, name, room_id, room_key, folder_id)
		 VALUES ($1, $2, $3, $4, $5) RETURNING updated_at`,
		boardID, name, roomID, roomKey, folder).Scan(&created); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create the board"})
		return
	}
	writeJSON(w, http.StatusCreated, createdBoard{
		boardSummary: boardSummary{
			ID:        boardID,
			Name:      name,
			FolderID:  req.FolderID,
			UpdatedAt: created,
		},
		RoomKey: roomKey,
	})
}

func (s *server) updateBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	var req struct {
		Name     *string `json:"name"`
		FolderID *string `json:"folderId"`
		Favorite *bool   `json:"favorite"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == nil && req.FolderID == nil && req.Favorite == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nothing to update"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var folder any
	if req.FolderID != nil && strings.TrimSpace(*req.FolderID) != "" {
		folder = strings.TrimSpace(*req.FolderID)
	}
	var board boardSummary
	err := s.db.QueryRow(ctx,
		`UPDATE boards
		 SET name = coalesce($2, name),
		     folder_id = case when $3 then $4 else folder_id end,
		     favorite = coalesce($5, favorite),
		     updated_at = case when $2 is not null or $3 then now() else updated_at end
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING id, name, coalesce(folder_id, ''), updated_at,
		           preview IS NOT NULL, favorite, deleted_at`,
		r.PathValue("id"), req.Name, req.FolderID != nil, folder, req.Favorite).
		Scan(&board.ID, &board.Name, &board.FolderID, &board.UpdatedAt,
			&board.HasPreview, &board.Favorite, &board.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not update the board"})
		return
	}
	writeJSON(w, http.StatusOK, board)
}

// deleteBoard moves a board to the trash. A purge removes it and its room for
// good, but only when no other board points at the room.
func (s *server) deleteBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if r.URL.Query().Get("purge") != "1" {
		tag, err := s.db.Exec(ctx,
			"UPDATE boards SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
			r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete the board"})
			return
		}
		if tag.RowsAffected() == 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete the board"})
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var roomID string
	err = tx.QueryRow(ctx, "DELETE FROM boards WHERE id = $1 RETURNING room_id",
		r.PathValue("id")).Scan(&roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete the board"})
		return
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM rooms WHERE room_id = $1
		 AND NOT EXISTS (SELECT 1 FROM boards WHERE room_id = $1)`, roomID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete the board"})
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete the board"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) restoreBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var board boardSummary
	err := s.db.QueryRow(ctx,
		`UPDATE boards SET deleted_at = NULL, updated_at = now()
		 WHERE id = $1 AND deleted_at IS NOT NULL
		 RETURNING id, name, coalesce(folder_id, ''), updated_at,
		           preview IS NOT NULL, favorite, deleted_at`,
		r.PathValue("id")).
		Scan(&board.ID, &board.Name, &board.FolderID, &board.UpdatedAt,
			&board.HasPreview, &board.Favorite, &board.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not restore the board"})
		return
	}
	writeJSON(w, http.StatusOK, board)
}

// duplicateBoard copies the row, the room scene, its files and the preview. The
// copy keeps the room key because the ciphertext cannot be re-encrypted on the
// server, but it always gets its own room, so the two boards edit independently.
func (s *server) duplicateBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not copy the board"})
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		name    string
		folder  *string
		roomID  string
		roomKey string
		preview []byte
	)
	err = tx.QueryRow(ctx,
		`SELECT name, folder_id, room_id, room_key, preview
		 FROM boards WHERE id = $1 AND deleted_at IS NULL`,
		r.PathValue("id")).Scan(&name, &folder, &roomID, &roomKey, &preview)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not copy the board"})
		return
	}

	boardID := newSlug(8)
	newRoomID := newSlug(10)
	copiedName := name + " (copy)"

	var created time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO boards (id, name, room_id, room_key, folder_id, preview)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING updated_at`,
		boardID, copiedName, newRoomID, roomKey, folder, preview).Scan(&created); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not copy the board"})
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO rooms (room_id, token_hash, ciphertext, iv, revision, scene_version)
		 SELECT $1, $2, ciphertext, iv, 1, scene_version
		 FROM rooms WHERE room_id = $3 AND ciphertext IS NOT NULL`,
		newRoomID, hashToken(boardRoomToken(roomKey)), roomID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not copy the board"})
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO room_files (room_id, file_id, payload)
		 SELECT $1, file_id, payload FROM room_files WHERE room_id = $2`,
		newRoomID, roomID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not copy the board"})
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not copy the board"})
		return
	}

	folderID := ""
	if folder != nil {
		folderID = *folder
	}
	writeJSON(w, http.StatusCreated, boardSummary{
		ID:         boardID,
		Name:       copiedName,
		FolderID:   folderID,
		UpdatedAt:  created,
		HasPreview: len(preview) > 0,
	})
}

func (s *server) getBoardScene(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var (
		roomID, roomKey string
		name            string
		ciphertext, iv  []byte
		revision        int64
		sceneVersion    int64
	)
	err := s.db.QueryRow(ctx,
		`SELECT b.name, b.room_id, b.room_key, r.ciphertext, r.iv, coalesce(r.revision, 0), coalesce(r.scene_version, 0)
		 FROM boards b LEFT JOIN rooms r ON r.room_id = b.room_id
		 WHERE b.id = $1 AND b.deleted_at IS NULL`,
		r.PathValue("id")).Scan(&name, &roomID, &roomKey, &ciphertext, &iv, &revision, &sceneVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "read failed"})
		return
	}

	scene := boardScene{
		RoomKey:      roomKey,
		RoomID:       roomID,
		Name:         name,
		Revision:     revision,
		SceneVersion: sceneVersion,
	}
	if ciphertext != nil {
		scene.Ciphertext = base64.StdEncoding.EncodeToString(ciphertext)
		scene.IV = base64.StdEncoding.EncodeToString(iv)
	}
	writeJSON(w, http.StatusOK, scene)
}

func (s *server) putBoardScene(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	var req boardScene
	if !decodeJSON(w, r, &req) {
		return
	}
	ciphertext, err1 := base64.StdEncoding.DecodeString(req.Ciphertext)
	iv, err2 := base64.StdEncoding.DecodeString(req.IV)
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

	var roomID, roomKey string
	if err := tx.QueryRow(ctx,
		"SELECT room_id, room_key FROM boards WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
		r.PathValue("id")).Scan(&roomID, &roomKey); errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}

	var revision int64
	err = tx.QueryRow(ctx,
		`INSERT INTO rooms (room_id, token_hash, ciphertext, iv, revision, scene_version)
		 VALUES ($1, $2, $3, $4, 1, $5)
		 ON CONFLICT (room_id) DO UPDATE
		   SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
		       revision = rooms.revision + 1,
		       scene_version = EXCLUDED.scene_version,
		       token_hash = case when length(rooms.token_hash) = 0
		                         then EXCLUDED.token_hash else rooms.token_hash end,
		       updated_at = now(), last_accessed_at = now()
		 WHERE rooms.revision = $6 OR rooms.ciphertext IS NULL
		 RETURNING revision`,
		roomID, hashToken(boardRoomToken(roomKey)), ciphertext, iv, req.SceneVersion, req.Revision).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		var current int64
		_ = tx.QueryRow(ctx, "SELECT revision FROM rooms WHERE room_id = $1", roomID).Scan(&current)
		writeJSON(w, http.StatusConflict, map[string]any{"error": "revision", "revision": current})
		return
	}
	if err != nil {
		log.Printf("save board scene: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	if _, err := tx.Exec(ctx, "UPDATE boards SET updated_at = now() WHERE room_id = $1", roomID); err != nil {
		log.Printf("touch board: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"revision": revision})
}

func (s *server) putBoardFile(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	boardID, fileID := r.PathValue("id"), r.PathValue("fileId")
	if !filePattern.MatchString(fileID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad file id"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var roomID string
	err := s.db.QueryRow(ctx,
		"SELECT room_id FROM boards WHERE id = $1 AND deleted_at IS NULL", boardID).Scan(&roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.maxBytes))
	if err != nil || len(body) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	if _, err := s.db.Exec(ctx,
		`INSERT INTO rooms (room_id, token_hash) VALUES ($1, decode('', 'hex'))
		 ON CONFLICT (room_id) DO NOTHING`, roomID); err != nil {
		log.Printf("ensure room: %v", err)
	}
	if _, err := s.db.Exec(ctx,
		`INSERT INTO room_files (room_id, file_id, payload) VALUES ($1, $2, $3)
		 ON CONFLICT (room_id, file_id) DO UPDATE SET payload = EXCLUDED.payload`,
		roomID, fileID, body); err != nil {
		log.Printf("insert board file: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) getBoardFile(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	boardID, fileID := r.PathValue("id"), r.PathValue("fileId")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var payload []byte
	err := s.db.QueryRow(ctx,
		`SELECT f.payload FROM room_files f
		 JOIN boards b ON b.room_id = f.room_id
		 WHERE b.id = $1 AND f.file_id = $2`,
		boardID, fileID).Scan(&payload)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	writeBlob(w, payload)
}

func (s *server) createFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a folder needs a name"})
		return
	}
	folder := folderSummary{ID: newSlug(8), Name: name}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, "INSERT INTO folders (id, name) VALUES ($1, $2)",
		folder.ID, folder.Name); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create the folder"})
		return
	}
	writeJSON(w, http.StatusCreated, folder)
}

func (s *server) updateFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a folder needs a name"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	tag, err := s.db.Exec(ctx, "UPDATE folders SET name = $2 WHERE id = $1",
		r.PathValue("id"), name)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not rename the folder"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such folder"})
		return
	}
	writeJSON(w, http.StatusOK, folderSummary{ID: r.PathValue("id"), Name: name})
}

// deleteFolder keeps the boards: folder_id is ON DELETE SET NULL.
func (s *server) deleteFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, "DELETE FROM folders WHERE id = $1",
		r.PathValue("id")); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete the folder"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) putBoardPreview(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil || len(body) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	tag, err := s.db.Exec(ctx,
		"UPDATE boards SET preview = $2 WHERE id = $1 AND deleted_at IS NULL",
		r.PathValue("id"), body)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such board"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) getBoardPreview(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var preview []byte
	err := s.db.QueryRow(ctx, "SELECT preview FROM boards WHERE id = $1",
		r.PathValue("id")).Scan(&preview)
	if err != nil || len(preview) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("Content-Length", strconv.Itoa(len(preview)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(preview)
}
