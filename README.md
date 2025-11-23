# Note Taker PoC

This workspace wires together a FastAPI backend that stores notes in MongoDB and a Chrome extension that captures selected text from any page.

## Backend (Python)

1. Start a MongoDB Docker container if you do not have one already:
   ```sh
   docker run -d --name note-mongo -p 27017:27017 mongo:7.0
   ```
2. Create and activate a Python virtual environment, then install dependencies:
   ```sh
   python -m venv .venv
   source .venv/bin/activate
   pip install -r backend/requirements.txt
   ```
3. Run the FastAPI service (adjust `MONGODB_URI`/`MONGODB_DB` as needed):
   ```sh
   MONGODB_URI="mongodb://localhost:27017" uvicorn backend.app:app --host 0.0.0.0 --port 5000 --reload
   ```
   The service listens on `http://localhost:5000`, exposes `POST /notes`, and a `/health` endpoint for probing connectivity.

### Optional Web UI

- A lightweight UI is available at `http://localhost:5000/ui/` for:
  - Scraping a URL and saving markdown
  - Creating a manual note
  - Browsing, searching and deleting notes
  
  The UI is served by FastAPI (StaticFiles). No Node build is required.

### Verify the backend
- Use `curl http://localhost:5000/health` and expect `{"status":"ok"}`.
- Save a test note with `curl -X POST http://localhost:5000/notes -H "Content-Type: application/json" -d '{"text":"Sample"}'`.

## Docker-based deployment

1. Build and start the stack with `docker compose up --build`. The compose stack brings up Mongo and the FastAPI backend, exposing ports `5000` for FastAPI and `27017` (host configurable) for Mongo.
2. Confirm the backend is ready by hitting `http://localhost:5000/health` and checking `docker compose logs backend` for any startup errors.
3. The chrome extension can continue to send notes to `http://localhost:5000/notes` while the compose stack is running.

### Scrape Website endpoint

- The endpoint `POST /scrape-website` calls a local Firecrawl service.
- By default, the backend reads `FIRECRAWL_BASE_URL` (set in `docker-compose.yml` to `http://host.docker.internal:8010` for container → host access).
- Make sure Firecrawl is running on your host at `http://localhost:8010`, or change `FIRECRAWL_BASE_URL` accordingly.
- When developing outside Docker, the backend will default to `http://localhost:8010` if `FIRECRAWL_BASE_URL` is unset.

### New API endpoints

- `GET /notes?q=&skip=0&limit=20` → Paginated list of notes
- `GET /notes/{id}` → Fetch a single note
- `DELETE /notes/{id}` → Remove a note

### Handling Mongo port conflicts

- If `27017` is already in use on your machine, set `MONGODB_HOST_PORT` before running compose, for example `MONGODB_HOST_PORT=27018 docker compose up --build`, and update tools that connect directly to Mongo accordingly.
- Use `docker compose exec mongo mongosh --eval 'use notes_db; db.notes.find().pretty()'` to inspect stored notes when you need to verify persistence separately from the extension.

### Accessing Mongo UI

- When the stack is running with `MONGODB_HOST_PORT`, connect tools such as MongoDB Compass or Mongo Express to `mongodb://localhost:${MONGODB_HOST_PORT:-27017}` to browse `notes_db` and the `notes` collection.
- If you prefer a web UI, run `docker run --rm -p 8081:8081 -e ME_CONFIG_MONGODB_SERVER=host.docker.internal -e ME_CONFIG_MONGODB_PORT=${MONGODB_HOST_PORT:-27017} mongo-express` and visit `http://localhost:8081` to inspect/save documents.

## Testing in your authenticated Chrome profile

1. Open Chrome with the profile you plan to use for reading and note-taking (the same authenticated session). Navigate to `chrome://extensions`, enable **Developer mode**, and click **Load unpacked** pointing at the `extension/` directory in this repo.
2. Once loaded, the extension is scoped to that profile and will remain enabled until you remove it.
3. Visit any page inside that profile (e.g., a site where you are signed in), select some text, and a widget will appear near the selection. Press **Save** to send the note to `http://localhost:5000/notes`. You can confirm the POST request succeeded from the Extension’s network requests (open DevTools → Network and filter by `notes`).
4. Monitor the backend logs (`docker compose logs -f backend`) to see insert confirmations, or rerun `curl http://localhost:5000/notes` to fetch stored IDs for debugging.

## Chrome Extension

1. Open `chrome://extensions`, toggle **Developer mode**, and select **Load unpacked**.
2. Point it at the `extension/` directory in this repo.
3. Visit any page, select some text, and the floating widget will appear. Click **Save** to send the selection to the FastAPI backend.

### How it works
- The content script injects a tiny widget near the selection, pre-fills the text, and POSTs the data to `http://localhost:5000/notes`.
- The backend persists the note in MongoDB with a timestamp, the page title, and the source URL.

## Customization & Troubleshooting
- Update `SERVER_ENDPOINT` in `extension/content.js` if the FastAPI service runs on a different port or host.
- Use the `/health` endpoint to confirm Mongo connectivity: `curl http://localhost:5000/health`.
- The backend honors `MONGODB_URI` and `MONGODB_DB` environment variables for connecting to Docker-hosted Mongo instances.
