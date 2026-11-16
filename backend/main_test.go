package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
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

func ownerRequest(method, path string, body string) *http.Request {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	req.Header.Set("X-Forwarded-Email", "me@example.com")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func TestBoardsRequireTheProxyHeader(t *testing.T) {
	s := testServer(t)
	if rec := do(t, s, httptest.NewRequest("GET", "/api/boards", nil)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", rec.Code)
	}
	forwardAuth := httptest.NewRequest("GET", "/api/boards", nil)
	forwardAuth.Header.Set("X-Auth-Request-Email", "me@example.com")
	if rec := do(t, s, forwardAuth); rec.Code != http.StatusOK {
		t.Fatalf("the forward-auth header must also be accepted, got %d", rec.Code)
	}
}

func TestBoardLifecycle(t *testing.T) {
	s := testServer(t)

	rec := do(t, s, ownerRequest("POST", "/api/boards", `{"name":"Architecture"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d (%s)", rec.Code, rec.Body)
	}
	var created boardSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	rec = do(t, s, ownerRequest("GET", "/api/boards", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Architecture") {
		t.Fatalf("list must include the board, got %d", rec.Code)
	}

	rec = do(t, s, ownerRequest("PATCH", "/api/boards/"+created.ID, `{"name":"Renamed"}`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Renamed") {
		t.Fatalf("rename: got %d (%s)", rec.Code, rec.Body)
	}

	// first scene write, then a stale revision, then the current one
	scene := func(revision int, cipher string) *httptest.ResponseRecorder {
		return do(t, s, ownerRequest("PUT", "/api/boards/"+created.ID+"/scene",
			`{"ciphertext":"`+base64.StdEncoding.EncodeToString([]byte(cipher))+`","iv":"`+
				base64.StdEncoding.EncodeToString([]byte("iv"))+`","sceneVersion":1,"revision":`+
				strconv.Itoa(revision)+`}`))
	}
	if rec := scene(0, "one"); rec.Code != http.StatusOK {
		t.Fatalf("first scene write: got %d (%s)", rec.Code, rec.Body)
	}
	if rec := scene(0, "stale"); rec.Code != http.StatusConflict {
		t.Fatalf("stale revision: got %d, want 409", rec.Code)
	}
	if rec := scene(1, "two"); rec.Code != http.StatusOK {
		t.Fatalf("second scene write: got %d (%s)", rec.Code, rec.Body)
	}

	rec = do(t, s, ownerRequest("GET", "/api/boards/"+created.ID+"/scene", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("read scene: got %d", rec.Code)
	}
	var stored boardScene
	if err := json.Unmarshal(rec.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 2 || stored.RoomKey == "" {
		t.Fatalf("scene must report revision 2 and the room key, got %+v", stored)
	}
	plain, _ := base64.StdEncoding.DecodeString(stored.Ciphertext)
	if string(plain) != "two" {
		t.Fatalf("ciphertext round trip failed: %q", plain)
	}

	var roomID string
	if err := s.db.QueryRow(context.Background(),
		"SELECT room_id FROM boards WHERE id = $1", created.ID).Scan(&roomID); err != nil {
		t.Fatal(err)
	}

	if rec := do(t, s, ownerRequest("DELETE", "/api/boards/"+created.ID, "")); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d", rec.Code)
	}
	rec = do(t, s, ownerRequest("GET", "/api/boards", ""))
	if !strings.Contains(rec.Body.String(), `"deletedAt":"`) {
		t.Fatalf("a trashed board must keep its row and its deletion time, got %s", rec.Body)
	}
	if rec := do(t, s, ownerRequest("GET", "/api/boards/"+created.ID+"/scene", "")); rec.Code != http.StatusNotFound {
		t.Fatalf("a trashed board must not open its scene, got %d", rec.Code)
	}
	if rec := do(t, s, ownerRequest("POST", "/api/boards/"+created.ID+"/restore", "")); rec.Code != http.StatusOK {
		t.Fatalf("restore: got %d (%s)", rec.Code, rec.Body)
	}
	if rec := do(t, s, ownerRequest("GET", "/api/boards/"+created.ID+"/scene", "")); rec.Code != http.StatusOK {
		t.Fatalf("a restored board must open again, got %d", rec.Code)
	}

	if rec := do(t, s, ownerRequest("DELETE", "/api/boards/"+created.ID+"?purge=1", "")); rec.Code != http.StatusNoContent {
		t.Fatalf("purge: got %d", rec.Code)
	}
	var rooms int
	if err := s.db.QueryRow(context.Background(),
		"SELECT count(*) FROM rooms WHERE room_id = $1", roomID).Scan(&rooms); err != nil {
		t.Fatal(err)
	}
	if rooms != 0 {
		t.Fatal("purging a board must drop its room when nothing else points at it")
	}
}

func TestBoardFavoriteDoesNotReorder(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, ownerRequest("POST", "/api/boards", `{"name":"Starred"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d", rec.Code)
	}
	var created boardSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	rec = do(t, s, ownerRequest("PATCH", "/api/boards/"+created.ID, `{"favorite":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("favorite: got %d (%s)", rec.Code, rec.Body)
	}
	var updated boardSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if !updated.Favorite {
		t.Fatal("the board must report its favorite flag")
	}
	if !updated.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("starring must not count as an edit: %s -> %s", created.UpdatedAt, updated.UpdatedAt)
	}
}

func TestBoardDuplicate(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, ownerRequest("POST", "/api/boards", `{"name":"Source"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d", rec.Code)
	}
	var created createdBoard
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	if rec := do(t, s, ownerRequest("PUT", "/api/boards/"+created.ID+"/scene",
		`{"ciphertext":"`+base64.StdEncoding.EncodeToString([]byte("scene"))+`","iv":"`+
			base64.StdEncoding.EncodeToString([]byte("iv"))+`","sceneVersion":1,"revision":0}`)); rec.Code != http.StatusOK {
		t.Fatalf("write scene: got %d (%s)", rec.Code, rec.Body)
	}
	fileReq := httptest.NewRequest("PUT", "/api/boards/"+created.ID+"/files/file1", strings.NewReader("blob"))
	fileReq.Header.Set("X-Forwarded-Email", "me@example.com")
	if rec := do(t, s, fileReq); rec.Code != http.StatusNoContent {
		t.Fatalf("write file: got %d (%s)", rec.Code, rec.Body)
	}
	previewReq := httptest.NewRequest("PUT", "/api/boards/"+created.ID+"/preview", strings.NewReader("png"))
	previewReq.Header.Set("X-Forwarded-Email", "me@example.com")
	if rec := do(t, s, previewReq); rec.Code != http.StatusNoContent {
		t.Fatalf("write preview: got %d", rec.Code)
	}

	var sourceRoomID string
	if err := s.db.QueryRow(context.Background(),
		"SELECT room_id FROM boards WHERE id = $1", created.ID).Scan(&sourceRoomID); err != nil {
		t.Fatal(err)
	}

	rec = do(t, s, ownerRequest("POST", "/api/boards/"+created.ID+"/duplicate", ""))
	if rec.Code != http.StatusCreated {
		t.Fatalf("duplicate: got %d (%s)", rec.Code, rec.Body)
	}
	var copy boardSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &copy); err != nil {
		t.Fatal(err)
	}
	if copy.ID == created.ID || copy.Name != "Source (copy)" || !copy.HasPreview {
		t.Fatalf("unexpected copy %+v", copy)
	}

	rec = do(t, s, ownerRequest("GET", "/api/boards/"+copy.ID+"/scene", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("read copy scene: got %d", rec.Code)
	}
	var copiedScene boardScene
	if err := json.Unmarshal(rec.Body.Bytes(), &copiedScene); err != nil {
		t.Fatal(err)
	}
	if copiedScene.RoomID == sourceRoomID || copiedScene.RoomKey != created.RoomKey {
		t.Fatalf("the copy needs its own room and the same key, got %+v", copiedScene)
	}
	if copiedScene.Ciphertext != base64.StdEncoding.EncodeToString([]byte("scene")) {
		t.Fatal("the copy must carry the source scene")
	}

	fileGet := httptest.NewRequest("GET", "/api/boards/"+copy.ID+"/files/file1", nil)
	fileGet.Header.Set("X-Forwarded-Email", "me@example.com")
	if rec := do(t, s, fileGet); rec.Code != http.StatusOK || rec.Body.String() != "blob" {
		t.Fatalf("copy file: got %d %q", rec.Code, rec.Body.String())
	}

	var roomID, roomKey string
	if err := s.db.QueryRow(context.Background(),
		"SELECT room_id, room_key FROM boards WHERE id = $1", copy.ID).Scan(&roomID, &roomKey); err != nil {
		t.Fatal(err)
	}
	var storedToken []byte
	if err := s.db.QueryRow(context.Background(),
		"SELECT token_hash FROM rooms WHERE room_id = $1", roomID).Scan(&storedToken); err != nil {
		t.Fatal(err)
	}
	if !tokenMatches(storedToken, hashToken(boardRoomToken(roomKey))) {
		t.Fatal("the copy's room must accept collaboration writes")
	}

	if rec := do(t, s, ownerRequest("DELETE", "/api/boards/"+created.ID, "")); rec.Code != http.StatusNoContent {
		t.Fatalf("trash the source: got %d", rec.Code)
	}
	rec = do(t, s, ownerRequest("GET", "/api/boards", ""))
	if !strings.Contains(rec.Body.String(), copy.ID) {
		t.Fatal("trashing the source must not touch the copy")
	}
}

func TestBoardRoomAcceptsCollabWrites(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, ownerRequest("POST", "/api/boards", `{"name":"Collab"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d", rec.Code)
	}
	var created createdBoard
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if rec := do(t, s, ownerRequest("PUT", "/api/boards/"+created.ID+"/scene",
		`{"ciphertext":"`+base64.StdEncoding.EncodeToString([]byte("scene"))+`","iv":"`+
			base64.StdEncoding.EncodeToString([]byte("iv"))+`","sceneVersion":1,"revision":0}`)); rec.Code != http.StatusOK {
		t.Fatalf("write scene: got %d (%s)", rec.Code, rec.Body)
	}

	var roomID string
	if err := s.db.QueryRow(context.Background(),
		"SELECT room_id FROM boards WHERE id = $1", created.ID).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{
		"ciphertext":   base64.StdEncoding.EncodeToString([]byte("collab")),
		"iv":           base64.StdEncoding.EncodeToString([]byte("iv")),
		"sceneVersion": 2,
		"revision":     1,
		"writeToken":   boardRoomToken(created.RoomKey),
	}
	if rec := do(t, s, roomRequest(t, "PUT", roomID, "", payload)); rec.Code != http.StatusOK {
		t.Fatalf("a board room must accept the collaboration write token, got %d (%s)", rec.Code, rec.Body)
	}
}

func TestTrashedBoardIsPurgedAfterAMonth(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, ownerRequest("POST", "/api/boards", `{"name":"Old"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d", rec.Code)
	}
	var created boardSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	var roomID string
	if err := s.db.QueryRow(context.Background(),
		"SELECT room_id FROM boards WHERE id = $1", created.ID).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(context.Background(),
		"UPDATE boards SET deleted_at = now() - interval '31 days' WHERE id = $1", created.ID); err != nil {
		t.Fatal(err)
	}

	if rec := do(t, s, ownerRequest("GET", "/api/boards", "")); rec.Code != http.StatusOK {
		t.Fatalf("list: got %d", rec.Code)
	}
	var boards, rooms int
	if err := s.db.QueryRow(context.Background(),
		"SELECT count(*) FROM boards WHERE id = $1", created.ID).Scan(&boards); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(context.Background(),
		"SELECT count(*) FROM rooms WHERE room_id = $1", roomID).Scan(&rooms); err != nil {
		t.Fatal(err)
	}
	if boards != 0 || rooms != 0 {
		t.Fatalf("a board trashed over 30 days ago must be purged, got %d boards and %d rooms", boards, rooms)
	}
}

func TestFolderLifecycle(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, ownerRequest("POST", "/api/boards/folders", `{"name":"Work"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create folder: got %d (%s)", rec.Code, rec.Body)
	}
	var folder folderSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &folder); err != nil {
		t.Fatal(err)
	}

	rec = do(t, s, ownerRequest("POST", "/api/boards", `{"name":"In folder","folderId":"`+folder.ID+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create board in folder: got %d", rec.Code)
	}
	var board boardSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &board); err != nil {
		t.Fatal(err)
	}
	if board.FolderID != folder.ID {
		t.Fatalf("board should sit in the folder, got %q", board.FolderID)
	}

	if rec := do(t, s, ownerRequest("PATCH", "/api/boards/"+board.ID, `{"folderId":""}`)); rec.Code != http.StatusOK {
		t.Fatalf("move out of the folder: got %d", rec.Code)
	}

	if rec := do(t, s, ownerRequest("DELETE", "/api/boards/folders/"+folder.ID, "")); rec.Code != http.StatusNoContent {
		t.Fatalf("delete folder: got %d", rec.Code)
	}
	var folderID string
	if err := s.db.QueryRow(context.Background(),
		"SELECT coalesce(folder_id, '') FROM boards WHERE id = $1", board.ID).Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	if folderID != "" {
		t.Fatalf("deleting a folder must unfile its boards, got %q", folderID)
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

func TestRoomWriteTouchesTheBoard(t *testing.T) {
	s := testServer(t)
	ctx := context.Background()
	roomID := newSlug(10)
	if _, err := s.db.Exec(ctx,
		"INSERT INTO boards (id, name, room_id, room_key, updated_at) VALUES ($1, $2, $3, $4, $5)",
		newSlug(8), "touched", roomID, newSlug(16), time.Now().Add(-48*time.Hour)); err != nil {
		t.Fatal(err)
	}

	payload := map[string]any{
		"ciphertext":   base64.StdEncoding.EncodeToString([]byte("cipher")),
		"iv":           base64.StdEncoding.EncodeToString([]byte("iv")),
		"sceneVersion": 1,
		"revision":     0,
		"writeToken":   "token",
	}
	if rec := do(t, s, roomRequest(t, "PUT", roomID, "", payload)); rec.Code != http.StatusOK {
		t.Fatalf("write: got %d", rec.Code)
	}

	var age time.Duration
	if err := s.db.QueryRow(ctx,
		"SELECT now() - updated_at FROM boards WHERE room_id = $1", roomID).Scan(&age); err != nil {
		t.Fatal(err)
	}
	if age > time.Minute {
		t.Fatalf("a room write must move the board up the gallery, updated_at is %s old", age)
	}
}

func TestBoardPreview(t *testing.T) {
	s := testServer(t)
	rec := do(t, s, ownerRequest("POST", "/api/boards", `{"name":"Preview"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d", rec.Code)
	}
	var board boardSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &board); err != nil {
		t.Fatal(err)
	}
	if board.HasPreview {
		t.Fatal("a fresh board has no preview")
	}

	req := ownerRequest("PUT", "/api/boards/"+board.ID+"/preview", "")
	req = httptest.NewRequest("PUT", "/api/boards/"+board.ID+"/preview", strings.NewReader("png-bytes"))
	req.Header.Set("X-Forwarded-Email", "me@example.com")
	if rec := do(t, s, req); rec.Code != http.StatusNoContent {
		t.Fatalf("upload preview: got %d (%s)", rec.Code, rec.Body)
	}

	req = httptest.NewRequest("GET", "/api/boards/"+board.ID+"/preview", nil)
	req.Header.Set("X-Forwarded-Email", "me@example.com")
	rec = do(t, s, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "png-bytes" {
		t.Fatalf("read preview: got %d %q", rec.Code, rec.Body.String())
	}

	rec = do(t, s, ownerRequest("GET", "/api/boards", ""))
	if !strings.Contains(rec.Body.String(), `"hasPreview":true`) {
		t.Fatalf("the list must report the preview, got %s", rec.Body)
	}
}
