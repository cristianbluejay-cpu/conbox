# Gonblox multiplayer deployment

GitHub Pages can host `index.html`, but it cannot run the Node/Socket.IO server. For public multiplayer:

1. Deploy this project, including `server.js`, to a Node host that supports WebSockets.
2. Set the server's `GONBLOX_ALLOWED_ORIGINS` environment variable to your GitHub Pages URL, for example:
   `https://your-name.github.io/your-repo`
3. Open `config.js` and set `window.GONBLOX_SERVER_URL` to the public HTTPS URL of that Node server.
4. Push the files to GitHub and enable GitHub Pages for the repository.

Use HTTPS for both the GitHub Pages site and the multiplayer server. Players who open the same GitHub Pages site will then connect to the same Socket.IO server and can see each other in games.

For local development, leave `window.GONBLOX_SERVER_URL` empty and run:

```text
npm install
npm start
```
