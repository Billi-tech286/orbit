# Orbit

Orbit is a small guest-first web app for real-time rooms, messaging, one-to-one WebRTC calls, and small live video rooms. It uses plain HTML, CSS, browser JavaScript, Node.js, Express, Socket.IO, WebRTC, and a MongoDB-or-SQLite persistence adapter.

## Run locally

1. Install Node.js 18 or newer.
2. Open this folder in VS Code.
3. Install dependencies:

```bash
npm install
```

4. Start the development server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in two browser windows.
6. Continue as Guest in each window. Create a room in one window, then join its six-character code in the other.

Use `npm start` for a normal Node.js start without file watching. When `MONGODB_URI` is set, Orbit uses MongoDB Atlas. Without it, Orbit uses the local SQLite fallback at `database/database.sqlite`.

## MongoDB Atlas setup

1. Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/atlas).
2. Create a database user and save its username and password.
3. In **Network Access**, add your deployment provider's outbound access. For a quick Render test, `0.0.0.0/0` works, but use tighter network rules for production where possible.
4. Copy the driver connection string and replace the username and password. URL-encode special password characters.
5. Set these environment variables locally or in your hosting provider:

```text
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=orbit
NODE_ENV=production
PORT=10000
```

PowerShell example for a local MongoDB run:

```powershell
$env:MONGODB_URI = "mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority"
$env:MONGODB_DB = "orbit"
npm start
```

The server creates indexes for users, sessions, rooms, messages, reactions, and read receipts on startup. It does not store WebRTC media, live socket membership, or live chat history in MongoDB.

## Publish with Render and MongoDB

1. Push this project to GitHub. Do not commit `.env`, `node_modules`, or database credentials.
2. In Render, create a **Web Service** from the repository.
3. Set the build command to `npm install`.
4. Set the start command to `npm start`.
5. Add `MONGODB_URI`, `MONGODB_DB=orbit`, and `NODE_ENV=production` under Render environment variables.
6. Deploy and open the HTTPS Render URL.

Render supplies `PORT` automatically. HTTPS is required for browser camera and microphone permissions, and Render provides it for the service URL. MongoDB Atlas keeps persistent data outside the web server, so a Render disk is not required for database persistence.

## Netlify frontend + Render backend

1. Deploy the `public` folder as the Netlify site directory. No build command is required.
2. After Render gives you a URL such as `https://orbit-api.onrender.com`, edit `public/config.js`:

```js
window.ORBIT_API_URL = 'https://orbit-api.onrender.com';
```

3. Commit and push that one-line URL change, then redeploy Netlify.
4. Set `FRONTEND_URL=https://your-orbit.netlify.app` in Render. It must exactly match the Netlify URL, including `https://` and without a trailing slash.
5. Keep `MONGODB_URI`, `MONGODB_DB=orbit`, and `NODE_ENV=production` in Render.

The frontend uses Render for `/api` requests and Socket.IO. Production cookies use `SameSite=None; Secure`, so login sessions work across Netlify and Render. Do not put the MongoDB URI in `public/config.js`.

## Testing calls and live video

Camera and microphone access works on `localhost` in modern browsers. Join the same room in two windows, then use `Call` beside the other guest. For Live, start a stream in one window; the other window will receive the live room event and can select `Watch` to connect as a viewer.

Browsers may block camera access when multiple tabs share a device. Use separate windows or browsers and allow the permission prompt. WebRTC media is peer-to-peer and is never stored in MongoDB or SQLite. Socket.IO carries signaling messages and live chat events.

## Project map

- `public/index.html` - app markup
- `public/style.css` - responsive dark interface
- `public/app.js` - guest state, views, chat, and WebRTC client logic
- `server/server.js` - Express, Socket.IO, rooms, presence, signaling, and database adapter
- `database/database.sqlite` - created at runtime only for the local SQLite fallback

## Current upgrade phase

The first upgrade phase adds optional permanent accounts without removing guest mode. Accounts support registration, login, logout, secure password hashing, cookie sessions, and editable username, bio, and avatar fields. Existing rooms, messaging, calls, and live media remain in place.

Room messaging now also supports emoji insertion, replies, reactions, editing and deleting your own messages, message history metadata, delivered/read indicators, and server-authorized action events. File attachments and voice messages are intentionally not advertised until object storage and upload validation are added.

Live rooms now include real-time live chat and a small-audience viewer registry. Viewer counts are based on connected live-room sockets, and live chat history is kept in memory only. The current WebRTC broadcast path is still peer-to-peer; use it for small groups, not large public broadcasts. An SFU/media server is the appropriate next scaling phase.

The larger social, media-upload, moderation, discovery, and creator features should be added in separate phases. Large media should use configurable S3-compatible object storage rather than SQLite, and large-scale live streaming should use an SFU instead of P2P mesh.
