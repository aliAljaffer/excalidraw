// Command scenes is the share-link store for the self-hosted Excalidraw app.
//
// The client compresses and encrypts the scene in the browser, so the server
// only ever sees an opaque blob: POST stores it and returns an id, GET returns
// the blob for that id.
package main

import (
	"context"
	"crypto/rand"
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
`

var (
	idPattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
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

func (s *server) sweep(ctx context.Context) {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			cutoff := now.AddDate(0, 0, -s.cfg.retentionDay)
			if _, err := s.db.Exec(ctx, "DELETE FROM scenes WHERE created_at < $1", cutoff); err != nil {
				log.Printf("retention sweep: %v", err)
			}
			s.limiter.sweep(now)
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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/v2/scenes", s.postScene)
	mux.HandleFunc("GET /api/v2/scenes/{id}", s.getScene)
	mux.HandleFunc("PUT /api/v2/scenes/{id}/files/{fileId}", s.putFile)
	mux.HandleFunc("GET /api/v2/scenes/{id}/files/{fileId}", s.getFile)

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           mux,
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
