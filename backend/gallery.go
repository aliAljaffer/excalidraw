package main

import (
	"html/template"
	"log"
	"net/http"
	"time"
)

type galleryData struct {
	Folders []folder
	Unfiled []board
	Total   int
}

type boardView struct {
	board
	Updated string
}

var galleryTmpl = template.Must(template.New("gallery").Funcs(template.FuncMap{
	"when": func(t time.Time) string {
		return t.Local().Format("2 Jan 2006 15:04")
	},
	"boards": func(bs []board) []boardView {
		out := make([]boardView, 0, len(bs))
		for _, b := range bs {
			out = append(out, boardView{board: b, Updated: b.UpdatedAt.Local().Format("2 Jan 2006 15:04")})
		}
		return out
	},
}).Parse(galleryHTML))

func (s *server) renderGallery(w http.ResponseWriter, data galleryData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := galleryTmpl.Execute(w, data); err != nil {
		log.Printf("render gallery: %v", err)
	}
}

const galleryHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boards</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px 64px; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
         background: #fafafa; color: #1b1b1f; }
  @media (prefers-color-scheme: dark) { body { background: #121212; color: #e8e8ec; } }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; margin: 32px 0 8px; opacity: .6; }
  .count { opacity: .6; margin-bottom: 24px; }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  input, select, button { font: inherit; padding: 6px 10px; border-radius: 6px;
                          border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; }
  button { cursor: pointer; }
  button.primary { background: #6965db; border-color: #6965db; color: #fff; }
  .folder-head { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .folder-head form { display: flex; gap: 6px; align-items: center; }
  .boards { display: grid; gap: 8px; margin: 12px 0 28px; }
  .card { border: 1px solid rgba(128,128,128,.28); border-radius: 10px; padding: 10px 12px;
          background: rgba(128,128,128,.06); }
  .card-top { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; }
  .card a { color: inherit; font-weight: 600; text-decoration: none; }
  .card a:hover { text-decoration: underline; }
  .meta { opacity: .6; font-size: 13px; white-space: nowrap; }
  details { margin-top: 6px; }
  summary { cursor: pointer; font-size: 13px; opacity: .6; }
  .manage { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .manage form { display: flex; gap: 6px; align-items: center; }
  .danger { color: #c92a2a; border-color: rgba(201,42,42,.4); }
  footer { margin-top: 40px; font-size: 13px; opacity: .5; }
</style>
</head>
<body>
<main>
  <h1>Boards</h1>
  <div class="count">{{.Total}} board{{if ne .Total 1}}s{{end}}, kept until you delete them</div>

  <div class="bar">
    <form method="post" action="/boards/new">
      <input name="name" placeholder="New board name" size="24">
      <select name="folder_id">
        <option value="">No folder</option>
        {{range .Folders}}<option value="{{.ID}}">{{.Name}}</option>{{end}}
      </select>
      <button class="primary" type="submit">New board</button>
    </form>
  </div>

  <div class="bar">
    <form method="post" action="/boards/folders/new">
      <input name="name" placeholder="New folder name" size="18" required>
      <button type="submit">New folder</button>
    </form>
  </div>

  {{range .Folders}}
  <section>
    <h2>{{.Name}}</h2>
    <div class="folder-head">
      <form method="post" action="/boards/new">
        <input type="hidden" name="folder_id" value="{{.ID}}">
        <input name="name" placeholder="New board name" size="18">
        <button type="submit">New board here</button>
      </form>
      <form method="post" action="/boards/folders/{{.ID}}/rename">
        <input name="name" value="{{.Name}}" size="12" required>
        <button type="submit">Rename folder</button>
      </form>
      <form method="post" action="/boards/folders/{{.ID}}/delete"
            onsubmit="return confirm('Delete this folder? Its boards move to unfiled.')">
        <button class="danger" type="submit">Delete folder</button>
      </form>
    </div>
    <div class="boards">
      {{range boards .Boards}}{{$b := .}}
      <div class="card">
        <div class="card-top">
          <a href="/boards/{{.ID}}">{{.Name}}</a>
          <span class="meta">{{.Updated}}</span>
        </div>
        <details>
          <summary>Manage</summary>
          <div class="manage">
            <form method="post" action="/boards/{{.ID}}/rename">
              <input name="name" value="{{.Name}}" size="20" required>
              <button type="submit">Rename</button>
            </form>
            <form method="post" action="/boards/{{.ID}}/move">
              <select name="folder_id">
                <option value="">No folder</option>
                {{range $.Folders}}<option value="{{.ID}}"{{if eq .ID $b.FolderID}} selected{{end}}>{{.Name}}</option>{{end}}
              </select>
              <button type="submit">Move</button>
            </form>
            <form method="post" action="/boards/{{.ID}}/delete"
                  onsubmit="return confirm('Delete this board and its drawing? This cannot be undone.')">
              <button class="danger" type="submit">Delete</button>
            </form>
          </div>
        </details>
      </div>
      {{end}}
    </div>
  </section>
  {{end}}

  <section>
    <h2>Unfiled</h2>
    <div class="boards">
      {{range boards .Unfiled}}{{$b := .}}
      <div class="card">
        <div class="card-top">
          <a href="/boards/{{.ID}}">{{.Name}}</a>
          <span class="meta">{{.Updated}}</span>
        </div>
        <details>
          <summary>Manage</summary>
          <div class="manage">
            <form method="post" action="/boards/{{.ID}}/rename">
              <input name="name" value="{{.Name}}" size="20" required>
              <button type="submit">Rename</button>
            </form>
            <form method="post" action="/boards/{{.ID}}/move">
              <select name="folder_id">
                <option value="">No folder</option>
                {{range $.Folders}}<option value="{{.ID}}"{{if eq .ID $b.FolderID}} selected{{end}}>{{.Name}}</option>{{end}}
              </select>
              <button type="submit">Move</button>
            </form>
            <form method="post" action="/boards/{{.ID}}/delete"
                  onsubmit="return confirm('Delete this board and its drawing? This cannot be undone.')">
              <button class="danger" type="submit">Delete</button>
            </form>
          </div>
        </details>
      </div>
      {{else}}
      <div class="card">No boards yet. Start one above.</div>
      {{end}}
    </div>
  </section>

  <footer>Boards are encrypted in the browser. The store keeps a room only while a board points at it.</footer>
</main>
</body>
</html>`
