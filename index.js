// Fallback entrypoint for hosts that use index.js as the Node startup file.
// The normal npm start command runs server.js directly.
import { startServer } from './server.js';

startServer();
