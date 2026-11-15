// Command scenes is the share-link and board store for the self-hosted
// Excalidraw app.
//
// The client compresses and encrypts the scene in the browser, so the server
// only ever sees an opaque blob: POST stores it and returns an id, GET returns
// the blob for that id. A board is a private pointer to a room plus a folder.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const schema = `
CREATE TABLE IF NOT EXISTS scenes (
    id         text PRIMARY KEY,
    payload    bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenes_created_at_idx ON scenes (created_at);
CREATE TABLE IF NOT EXISTS scene_files (
    scene_id   text NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
    file_id    text NOT NULL,
    payload    bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scene_id, file_id)
);

-- A room holds one encrypted scene, written by any participant holding the
-- room key. token_hash is the sha256 of that key, so the database alone never
-- yields write access.
CREATE TABLE IF NOT EXISTS rooms (
    room_id          text PRIMARY KEY,
    token_hash       bytea NOT NULL,
    ciphertext       bytea,
    iv               bytea,
    revision         bigint NOT NULL DEFAULT 0,
    scene_version    bigint NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    last_accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_last_accessed_idx ON rooms (last_accessed_at);
CREATE TABLE IF NOT EXISTS room_files (
    room_id    text NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    file_id    text NOT NULL,
    payload    bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, file_id)
);

CREATE TABLE IF NOT EXISTS folders (
    id         text PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- room_key is stored so a board opens from any device without a passphrase.
CREATE TABLE IF NOT EXISTS boards (
    id         text PRIMARY KEY,
    name       text NOT NULL,
    room_id    text NOT NULL,
    room_key   text NOT NULL,
    folder_id  text REFERENCES folders (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- A small PNG of the board, shown in the gallery. Derived data: never bumped
-- into updated_at.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS preview bytea;
CREATE INDEX IF NOT EXISTS boards_room_idx ON boards (room_id);
CREATE INDEX IF NOT EXISTS boards_folder_idx ON boards (folder_id);
`

var (
	idPattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	slugPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	filePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

type config struct {
	addr         string
	databaseURL  string
	maxBytes     int64
	perHour      int
	retentionDay int
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return fallback
}

func load() config {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	return config{
		addr:         env("LISTEN_ADDR", ":8080"),
		databaseURL:  databaseURL,
		maxBytes:     int64(envInt("MAX_BYTES", 10<<20)),
		perHour:      envInt("UPLOADS_PER_HOUR", 30),
		retentionDay: envInt("RETENTION_DAYS", 90),
	}
}

// fixed-window counter per client IP, enough to stop a single caller from
// filling the database.
type window struct {
	count int
	reset time.Time
}

type limiter struct {
	mu      sync.Mutex
	hits    map[string]*window
	perHour int
}

func newLimiter(perHour int) *limiter {
	return &limiter{hits: map[string]*window{}, perHour: perHour}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.hits[key]
	if !ok || now.After(w.reset) {
		l.hits[key] = &window{count: 1, reset: now.Add(time.Hour)}
		return true
	}
	if w.count >= l.perHour {
		return false
	}
	w.count++
	return true
}

func (l *limiter) sweep(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, w := range l.hits {
		if now.After(w.reset) {
			delete(l.hits, k)
		}
	}
}

func newID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// newSlug returns a URL-safe id of the given entropy in bytes.
func newSlug(size int) string {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type server struct {
	db      *pgxpool.Pool
	cfg     config
	limiter *limiter
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database unavailable"})
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok\n")
}

func (s *server) postScene(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow(clientIP(r), time.Now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many uploads"})
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.maxBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error_class": "RequestTooLargeError"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
		return
	}
	if len(body) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty body"})
		return
	}

	id, err := newID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "id generation failed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := s.db.Exec(ctx, "INSERT INTO scenes (id, payload) VALUES ($1, $2)", id, body); err != nil {
		log.Printf("insert scene: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (s *server) getScene(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !idPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var payload []byte
	err := s.db.QueryRow(ctx, "SELECT payload FROM scenes WHERE id = $1", id).Scan(&payload)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	writeBlob(w, payload)
}

func (s *server) putFile(w http.ResponseWriter, r *http.Request) {
	sceneID, fileID := r.PathValue("id"), r.PathValue("fileId")
	if !idPattern.MatchString(sceneID) || !filePattern.MatchString(fileID) {
		http.NotFound(w, r)
		return
	}
	if !s.limiter.allow(clientIP(r), time.Now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many uploads"})
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
		`INSERT INTO scene_files (scene_id, file_id, payload) VALUES ($1, $2, $3)
		 ON CONFLICT (scene_id, file_id) DO UPDATE SET payload = EXCLUDED.payload`,
		sceneID, fileID, body)
	if err != nil {
		log.Printf("insert scene file: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) getFile(w http.ResponseWriter, r *http.Request) {
	sceneID, fileID := r.PathValue("id"), r.PathValue("fileId")
	if !idPattern.MatchString(sceneID) || !filePattern.MatchString(fileID) {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var payload []byte
	err := s.db.QueryRow(ctx,
		"SELECT payload FROM scene_files WHERE scene_id = $1 AND file_id = $2",
		sceneID, fileID).Scan(&payload)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	writeBlob(w, payload)
}

func writeBlob(w http.ResponseWriter, payload []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

// sweepOnce drops share-link scenes and rooms that no board points at. A board
// is the promise that the scene stays, so its room is exempt however old it is.
func (s *server) sweepOnce(ctx context.Context, now time.Time) {
	cutoff := now.AddDate(0, 0, -s.cfg.retentionDay)
	if _, err := s.db.Exec(ctx, "DELETE FROM scenes WHERE created_at < $1", cutoff); err != nil {
		log.Printf("retention sweep scenes: %v", err)
	}
	if _, err := s.db.Exec(ctx,
		`DELETE FROM rooms r
		 WHERE r.last_accessed_at < $1
		   AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.room_id = r.room_id)`,
		cutoff); err != nil {
		log.Printf("retention sweep rooms: %v", err)
	}
	s.limiter.sweep(now)
}

func (s *server) sweep(ctx context.Context) {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.sweepOnce(ctx, now)
		}
	}
}

func connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	var lastErr error
	for attempt := 0; attempt < 30; attempt++ {
		pool, err := pgxpool.New(ctx, url)
		if err == nil {
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = pool.Ping(pingCtx)
			cancel()
			if err == nil {
				return pool, nil
			}
			pool.Close()
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return nil, lastErr
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/v2/scenes", s.postScene)
	mux.HandleFunc("GET /api/v2/scenes/{id}", s.getScene)
	mux.HandleFunc("PUT /api/v2/scenes/{id}/files/{fileId}", s.putFile)
	mux.HandleFunc("GET /api/v2/scenes/{id}/files/{fileId}", s.getFile)

	mux.HandleFunc("GET /api/v2/rooms/{id}", s.getRoom)
	mux.HandleFunc("PUT /api/v2/rooms/{id}", s.putRoom)
	mux.HandleFunc("PUT /api/v2/rooms/{id}/files/{fileId}", s.putRoomFile)
	mux.HandleFunc("GET /api/v2/rooms/{id}/files/{fileId}", s.getRoomFile)

	mux.HandleFunc("GET /api/boards", s.listBoards)
	mux.HandleFunc("POST /api/boards", s.createBoard)
	mux.HandleFunc("PATCH /api/boards/{id}", s.updateBoard)
	mux.HandleFunc("DELETE /api/boards/{id}", s.deleteBoard)
	mux.HandleFunc("GET /api/boards/{id}/scene", s.getBoardScene)
	mux.HandleFunc("PUT /api/boards/{id}/scene", s.putBoardScene)
	mux.HandleFunc("GET /api/boards/{id}/preview", s.getBoardPreview)
	mux.HandleFunc("PUT /api/boards/{id}/preview", s.putBoardPreview)
	mux.HandleFunc("GET /api/boards/{id}/files/{fileId}", s.getBoardFile)
	mux.HandleFunc("PUT /api/boards/{id}/files/{fileId}", s.putBoardFile)
	mux.HandleFunc("POST /api/boards/folders", s.createFolder)
	mux.HandleFunc("PATCH /api/boards/folders/{id}", s.updateFolder)
	mux.HandleFunc("DELETE /api/boards/folders/{id}", s.deleteFolder)
	return mux
}

func main() {
	cfg := load()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := connect(ctx, cfg.databaseURL)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(ctx, schema); err != nil {
		log.Fatalf("schema: %v", err)
	}

	s := &server{db: db, cfg: cfg, limiter: newLimiter(cfg.perHour)}
	go s.sweep(ctx)

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("listening on %s (max upload %d bytes, %d uploads/hour, retention %d days)",
		cfg.addr, cfg.maxBytes, cfg.perHour, cfg.retentionDay)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
