package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type board struct {
	ID        string
	Name      string
	RoomID    string
	RoomKey   string
	FolderID  string
	UpdatedAt time.Time
}

type folder struct {
	ID     string
	Name   string
	Boards []board
}

// groupBoards buckets boards into their folders, keeping the input order of
// both. A board whose folder vanished lands in the unfiled list.
func groupBoards(folders []folder, boards []board) ([]folder, []board) {
	index := make(map[string]int, len(folders))
	for i, f := range folders {
		index[f.ID] = i
	}
	unfiled := []board{}
	for _, b := range boards {
		if i, ok := index[b.FolderID]; ok {
			folders[i].Boards = append(folders[i].Boards, b)
		} else {
			unfiled = append(unfiled, b)
		}
	}
	return folders, unfiled
}

// requireOwner refuses anything that did not come through oauth2-proxy. The
// public gateway only reaches this handler for /boards, and the proxy is the
// only caller that sets the header.
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
	http.Error(w, "login required", http.StatusUnauthorized)
	return false
}

func (s *server) gallery(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := s.db.Query(ctx,
		`SELECT id, name, room_id, room_key, coalesce(folder_id, ''), updated_at
		 FROM boards ORDER BY updated_at DESC`)
	if err != nil {
		http.Error(w, "gallery unavailable", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	boards := []board{}
	for rows.Next() {
		var b board
		if err := rows.Scan(&b.ID, &b.Name, &b.RoomID, &b.RoomKey, &b.FolderID, &b.UpdatedAt); err != nil {
			http.Error(w, "gallery unavailable", http.StatusInternalServerError)
			return
		}
		boards = append(boards, b)
	}
	if rows.Err() != nil {
		http.Error(w, "gallery unavailable", http.StatusInternalServerError)
		return
	}

	folderRows, err := s.db.Query(ctx, "SELECT id, name FROM folders ORDER BY lower(name)")
	if err != nil {
		http.Error(w, "gallery unavailable", http.StatusInternalServerError)
		return
	}
	defer folderRows.Close()

	folders := []folder{}
	for folderRows.Next() {
		var f folder
		if err := folderRows.Scan(&f.ID, &f.Name); err != nil {
			http.Error(w, "gallery unavailable", http.StatusInternalServerError)
			return
		}
		folders = append(folders, f)
	}
	if folderRows.Err() != nil {
		http.Error(w, "gallery unavailable", http.StatusInternalServerError)
		return
	}

	folders, unfiled := groupBoards(folders, boards)

	s.renderGallery(w, galleryData{
		Folders: folders,
		Unfiled: unfiled,
		Total:   len(boards),
	})
}

func (s *server) openBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var roomID, roomKey string
	err := s.db.QueryRow(ctx,
		"SELECT room_id, room_key FROM boards WHERE id = $1", id).Scan(&roomID, &roomKey)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// The key belongs in the fragment so it never reaches the server again.
	http.Redirect(w, r, "/s/#room="+roomID+","+roomKey, http.StatusFound)
}

func (s *server) createBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "Board " + time.Now().Format("2 Jan 2006 15:04")
	}
	folderID := strings.TrimSpace(r.FormValue("folder_id"))

	roomID := newSlug(10)
	roomKey := newSlug(16)
	boardID := newSlug(8)

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var folder any
	if folderID != "" {
		folder = folderID
	}
	if _, err := s.db.Exec(ctx,
		`INSERT INTO boards (id, name, room_id, room_key, folder_id)
		 VALUES ($1, $2, $3, $4, $5)`,
		boardID, name, roomID, roomKey, folder); err != nil {
		http.Error(w, "could not create the board", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/s/#room="+roomID+","+roomKey, http.StatusFound)
}

func (s *server) renameBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		http.Redirect(w, r, "/boards", http.StatusFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	_, err := s.db.Exec(ctx,
		"UPDATE boards SET name = $2, updated_at = now() WHERE id = $1",
		r.PathValue("id"), name)
	if err != nil {
		http.Error(w, "could not rename the board", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/boards", http.StatusFound)
}

func (s *server) moveBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	folderID := strings.TrimSpace(r.FormValue("folder_id"))
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var folder any
	if folderID != "" {
		folder = folderID
	}
	_, err := s.db.Exec(ctx,
		"UPDATE boards SET folder_id = $2, updated_at = now() WHERE id = $1",
		r.PathValue("id"), folder)
	if err != nil {
		http.Error(w, "could not move the board", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/boards", http.StatusFound)
}

// deleteBoard drops the board, and the room with it when no other board points
// at the same room. Leaving the room to age out would keep an orphan around.
func (s *server) deleteBoard(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	tx, err := s.db.Begin(ctx)
	if err != nil {
		http.Error(w, "could not delete the board", http.StatusInternalServerError)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var roomID string
	err = tx.QueryRow(ctx, "DELETE FROM boards WHERE id = $1 RETURNING room_id",
		r.PathValue("id")).Scan(&roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "could not delete the board", http.StatusInternalServerError)
		return
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM rooms WHERE room_id = $1
		 AND NOT EXISTS (SELECT 1 FROM boards WHERE room_id = $1)`, roomID); err != nil {
		http.Error(w, "could not delete the board", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		http.Error(w, "could not delete the board", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/boards", http.StatusFound)
}

func (s *server) createFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		http.Redirect(w, r, "/boards", http.StatusFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, "INSERT INTO folders (id, name) VALUES ($1, $2)",
		newSlug(8), name); err != nil {
		http.Error(w, "could not create the folder", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/boards", http.StatusFound)
}

func (s *server) renameFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		http.Redirect(w, r, "/boards", http.StatusFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, "UPDATE folders SET name = $2 WHERE id = $1",
		r.PathValue("id"), name); err != nil {
		http.Error(w, "could not rename the folder", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/boards", http.StatusFound)
}

// deleteFolder keeps the boards: folder_id is ON DELETE SET NULL, so they land
// back in the unfiled list.
func (s *server) deleteFolder(w http.ResponseWriter, r *http.Request) {
	if !s.requireOwner(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, "DELETE FROM folders WHERE id = $1",
		r.PathValue("id")); err != nil {
		http.Error(w, "could not delete the folder", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/boards", http.StatusFound)
}
