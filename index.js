const http = require('http');
const dotenv = require('dotenv');

// dotenv.config({ path: './config/config.env' });
dotenv.config();

const app = require('./app');
const socket = require('./socket');

const server = http.createServer(app);
socket.init(server);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
