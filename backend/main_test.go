package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLimiterWindow(t *testing.T) {
	l := newLimiter(2)
	now := time.Unix(0, 0)

	if !l.allow("1.2.3.4", now) || !l.allow("1.2.3.4", now) {
		t.Fatal("first two uploads must pass")
	}
	if l.allow("1.2.3.4", now) {
		t.Fatal("third upload in the same window must be rejected")
	}
	if !l.allow("5.6.7.8", now) {
		t.Fatal("a different client gets its own budget")
	}
	if !l.allow("1.2.3.4", now.Add(time.Hour+time.Second)) {
		t.Fatal("budget must reset after an hour")
	}
}

func TestLimiterSweep(t *testing.T) {
	l := newLimiter(5)
	now := time.Unix(0, 0)
	l.allow("1.2.3.4", now)
	l.sweep(now.Add(2 * time.Hour))
	if len(l.hits) != 0 {
		t.Fatalf("expired clients should be dropped, got %d", len(l.hits))
	}
}

func TestNewID(t *testing.T) {
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 32 {
		t.Fatalf("id must be 32 hex characters, got %q", id)
	}
	other, _ := newID()
	if id == other {
		t.Fatal("ids must be unique")
	}
}

func TestRoomKeyShapes(t *testing.T) {
	for _, size := range []int{8, 10, 16} {
		slug := newSlug(size)
		if !slugPattern.MatchString(slug) {
			t.Fatalf("slug %q must satisfy the room pattern", slug)
		}
	}
	// the app refuses a room key that is not 22 characters
	if got := newSlug(16); len(got) != 22 {
		t.Fatalf("room key must be 22 characters, got %d", len(got))
	}
}

func TestTokenMatches(t *testing.T) {
	token := hashToken("secret")
	if !tokenMatches(token, hashToken("secret")) {
		t.Fatal("the same token must match")
	}
	if tokenMatches(token, hashToken("other")) {
		t.Fatal("a different token must not match")
	}
	if tokenMatches(token, nil) {
		t.Fatal("a missing token must not match")
	}
}

func TestGroupBoards(t *testing.T) {
	folders := []folder{{ID: "f1", Name: "Work"}}
	boards := []board{
		{ID: "b1", Name: "one", FolderID: "f1"},
		{ID: "b2", Name: "two"},
		{ID: "b3", Name: "three", FolderID: "gone"},
	}
	gotFolders, unfiled := groupBoards(folders, boards)

	if len(gotFolders[0].Boards) != 1 || gotFolders[0].Boards[0].ID != "b1" {
		t.Fatalf("folder should hold b1, got %+v", gotFolders[0].Boards)
	}
	if len(unfiled) != 2 {
		t.Fatalf("boards in no folder, or in a deleted one, must be unfiled, got %d", len(unfiled))
	}
}

// --- integration, needs TEST_DATABASE_URL ---

func testServer(t *testing.T) *server {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, schema); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		"DELETE FROM room_files", "DELETE FROM rooms", "DELETE FROM boards", "DELETE FROM folders", "DELETE FROM scenes",
	} {
		if _, err := db.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(db.Close)
	return &server{db: db, cfg: config{maxBytes: 10 << 20, perHour: 1000, retentionDay: 90}, limiter: newLimiter(1000)}
}

func do(t *testing.T, s *server, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

func roomRequest(t *testing.T, method, roomID, token string, payload map[string]any) *http.Request {
	t.Helper()
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(method, "/api/v2/rooms/"+roomID, strings.NewReader(string(body)))
	req.SetPathValue("id", roomID)
	if token != "" {
		req.Header.Set("X-Room-Token", token)
	}
	return req
}

func TestRoomRevisionAndToken(t *testing.T) {
	s := testServer(t)
	room := newSlug(10)
	token := base64.RawURLEncoding.EncodeToString([]byte("0123456789abcdef"))

	payload := map[string]any{
		"ciphertext":   base64.StdEncoding.EncodeToString([]byte("cipher")),
		"iv":           base64.StdEncoding.EncodeToString([]byte("iv")),
		"sceneVersion": 1,
		"revision":     0,
		"writeToken":   token,
	}
	if rec := do(t, s, roomRequest(t, "PUT", room, "", payload)); rec.Code != http.StatusOK {
		t.Fatalf("first write: got %d, want 200 (%s)", rec.Code, rec.Body)
	}

	payload["revision"] = 0
	if rec := do(t, s, roomRequest(t, "PUT", room, "", payload)); rec.Code != http.StatusConflict {
		t.Fatalf("stale revision: got %d, want 409", rec.Code)
	}

	payload["revision"] = 1
	payload["writeToken"] = "not-the-key"
	if rec := do(t, s, roomRequest(t, "PUT", room, "", payload)); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong token: got %d, want 403", rec.Code)
	}

	payload["writeToken"] = token
	if rec := do(t, s, roomRequest(t, "PUT", room, "", payload)); rec.Code != http.StatusOK {
		t.Fatalf("second write: got %d, want 200 (%s)", rec.Code, rec.Body)
	}

	rec := do(t, s, httptest.NewRequest("GET", "/api/v2/rooms/"+room, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("read: got %d, want 200", rec.Code)
	}
	var stored struct {
		Ciphertext   string `json:"ciphertext"`
		Revision     int64  `json:"revision"`
		SceneVersion int64  `json:"sceneVersion"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 2 {
		t.Fatalf("revision after two writes: got %d, want 2", stored.Revision)
	}
	plain, _ := base64.StdEncoding.DecodeString(stored.Ciphertext)
	if string(plain) != "cipher" {
		t.Fatalf("ciphertext round trip failed: %q", plain)
	}
}

func TestUnknownRoomIs404(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, httptest.NewRequest("GET", "/api/v2/rooms/"+newSlug(10), nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", rec.Code)
	}
}

func TestBoardLifecycle(t *testing.T) {
	s := testServer(t)
	auth := func(r *http.Request) *http.Request {
		r.Header.Set("X-Auth-Request-Email", "me@example.com")
		return r
	}

	form := url.Values{"name": {"Architecture"}, "folder_id": {""}}
	req := auth(httptest.NewRequest("POST", "/boards/new", strings.NewReader(form.Encode())))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := do(t, s, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("create board: got %d, want 302 (%s)", rec.Code, rec.Body)
	}
	open := rec.Header().Get("Location")
	if !strings.HasPrefix(open, "/s/#room=") {
		t.Fatalf("new board must open the public room link, got %q", open)
	}

	rec = do(t, s, auth(httptest.NewRequest("GET", "/boards", nil)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Architecture") {
		t.Fatalf("gallery must list the board, got %d", rec.Code)
	}

	withoutAuth := do(t, s, httptest.NewRequest("GET", "/boards", nil))
	if withoutAuth.Code != http.StatusUnauthorized {
		t.Fatalf("gallery without the proxy header must be 401, got %d", withoutAuth.Code)
	}

	var boardID, roomID string
	if err := s.db.QueryRow(context.Background(),
		"SELECT id, room_id FROM boards").Scan(&boardID, &roomID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := s.db.Exec(ctx,
		"INSERT INTO rooms (room_id, token_hash, ciphertext, iv, revision) VALUES ($1, $2, $3, $4, 1)",
		roomID, hashToken("k"), []byte("c"), []byte("i")); err != nil {
		t.Fatal(err)
	}

	req = auth(httptest.NewRequest("POST", "/boards/"+boardID+"/delete", nil))
	req.SetPathValue("id", boardID)
	if rec := do(t, s, req); rec.Code != http.StatusFound {
		t.Fatalf("delete: got %d", rec.Code)
	}
	var rooms int
	if err := s.db.QueryRow(ctx, "SELECT count(*) FROM rooms WHERE room_id = $1", roomID).Scan(&rooms); err != nil {
		t.Fatal(err)
	}
	if rooms != 0 {
		t.Fatal("deleting a board must drop its room when nothing else points at it")
	}
}

func TestRetentionSparesBoardRooms(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	old := time.Now().AddDate(0, 0, -365)

	keep := newSlug(10)
	drop := newSlug(10)
	for _, room := range []string{keep, drop} {
		if _, err := s.db.Exec(ctx,
			`INSERT INTO rooms (room_id, token_hash, ciphertext, iv, revision, last_accessed_at)
			 VALUES ($1, $2, $3, $4, 1, $5)`,
			room, hashToken("k"), []byte("c"), []byte("i"), old); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec(ctx,
		"INSERT INTO boards (id, name, room_id, room_key) VALUES ($1, $2, $3, $4)",
		newSlug(8), "kept", keep, newSlug(16)); err != nil {
		t.Fatal(err)
	}

	s.sweepOnce(ctx, time.Now())

	for _, tc := range []struct {
		room string
		want int
	}{{keep, 1}, {drop, 0}} {
		var n int
		if err := s.db.QueryRow(ctx, "SELECT count(*) FROM rooms WHERE room_id = $1", tc.room).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != tc.want {
			t.Fatalf("room %s after sweep: got %d rows, want %d", tc.room, n, tc.want)
		}
	}
}

func TestGalleryRendersHTML(t *testing.T) {
	s := testServer(t)
	req := httptest.NewRequest("GET", "/boards", nil)
	req.Header.Set("X-Auth-Request-Email", "me@example.com")
	rec := do(t, s, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	body, _ := io.ReadAll(rec.Body)
	if !strings.Contains(string(body), "New board") {
		t.Fatal("gallery must offer a new board")
	}
	if !strings.Contains(string(body), "New folder") {
		t.Fatal("gallery must offer a new folder")
	}
}
