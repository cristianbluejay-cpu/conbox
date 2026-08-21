const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const blocksFile = path.join(__dirname, 'placed-blocks.json');
const deletedMapPartsFile = path.join(__dirname, 'deleted-map-parts.json');
const friendshipsFile = path.join(__dirname, 'friendships.json');

// Serve the project root, where index.html is located.
app.use(express.static('.'));

const players = {};
const friendships = new Map();
const pendingFriendRequests = new Map();
let placedBlocks = [];
let deletedMapParts = [];
const allowedBlockSizes = new Set([2, 4, 6, 8]);

function broadcastGamePlayerCounts() {
    const counts = {};
    Object.values(players).forEach(player => {
        if (player.gameId) counts[player.gameId] = (counts[player.gameId] || 0) + 1;
    });
    io.emit('game_player_counts', counts);
}

try {
    if (fs.existsSync(friendshipsFile)) {
        const savedFriendships = JSON.parse(fs.readFileSync(friendshipsFile, 'utf8'));
        Object.entries(savedFriendships).forEach(([name, friendNames]) => friendships.set(name, new Set(friendNames)));
    }
} catch (error) {
    console.error('Could not load friendships:', error.message);
}

function saveFriendships() {
    const data = Object.fromEntries([...friendships.entries()].map(([name, names]) => [name, [...names]]));
    fs.writeFileSync(friendshipsFile, JSON.stringify(data, null, 2));
}

function getFriendList(playerName) {
    const names = friendships.get(playerName) || new Set();
    return [...names].map(name => {
        const onlineEntry = Object.entries(players).find(([, player]) => player.name === name);
        const onlinePlayer = onlineEntry ? onlineEntry[1] : null;
        return {
            name,
            online: Boolean(onlinePlayer),
            playerId: onlineEntry ? onlineEntry[0] : null,
            gameId: onlinePlayer?.gameId || null,
            gameType: onlinePlayer?.gameType || null,
            gameTitle: onlinePlayer?.gameTitle || null,
            gameIsUserCreated: Boolean(onlinePlayer?.gameIsUserCreated),
            appearance: onlinePlayer?.appearance || null
        };
    });
}

function sendFriendList(socketId) {
    const player = players[socketId];
    if (player) io.to(socketId).emit('friend_list', getFriendList(player.name));
}

function refreshOnlineFriendLists(playerName) {
    for (const [socketId, player] of Object.entries(players)) {
        if ((friendships.get(playerName) || new Set()).has(player.name)) sendFriendList(socketId);
    }
}

try {
    if (fs.existsSync(blocksFile)) {
        const savedBlocks = JSON.parse(fs.readFileSync(blocksFile, 'utf8'));
        if (Array.isArray(savedBlocks)) placedBlocks = savedBlocks;
    }
} catch (error) {
    console.error('Could not load placed blocks:', error.message);
}

try {
    if (fs.existsSync(deletedMapPartsFile)) {
        const savedParts = JSON.parse(fs.readFileSync(deletedMapPartsFile, 'utf8'));
        if (Array.isArray(savedParts)) deletedMapParts = savedParts;
    }
} catch (error) {
    console.error('Could not load deleted map parts:', error.message);
}

function savePlacedBlocks() {
    try {
        fs.writeFileSync(blocksFile, JSON.stringify(placedBlocks, null, 2));
    } catch (error) {
        console.error('Could not save placed blocks:', error.message);
    }
}

function saveDeletedMapParts() {
    try {
        fs.writeFileSync(deletedMapPartsFile, JSON.stringify(deletedMapParts, null, 2));
    } catch (error) {
        console.error('Could not save deleted map parts:', error.message);
    }
}

function isValidBlock(block) {
    return block &&
    typeof block.gameId === 'string' && block.gameId.length > 0 &&
        ['x', 'y', 'z'].every(key => Number.isFinite(block[key])) &&
        allowedBlockSizes.has(block.size) &&
        /^#[0-9a-f]{6}$/i.test(block.color) &&
        (block.gameType === 'park' || block.gameType === 'island');
}

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('identify_user', (data) => {
        players[socket.id] = {
            name: String(data.name || 'Player'),
            device: String(data.device || 'Unknown'),
            appearance: data.appearance || null,
            gameId: null,
            gameType: null,
            gameTitle: null,
            gameIsUserCreated: false,
            chatMessage: ''
        };
        sendFriendList(socket.id);
    });

    socket.on('update_appearance', ({ appearance }) => {
        if (!players[socket.id]) return;
        players[socket.id].appearance = appearance || null;
        sendFriendList(socket.id);
        refreshOnlineFriendLists(players[socket.id].name);
    });

    // When a player joins, set up their default position and info
    socket.on('join_game', (data) => {
        const joiningName = String(data.name || 'Player');
        const friendAlreadyInGame = Object.entries(players).find(([id, player]) =>
            id !== socket.id && player.gameId === data.gameId && (friendships.get(joiningName) || new Set()).has(player.name)
        );
        if (players[socket.id]?.gameId) socket.leave(players[socket.id].gameId);
        if (typeof data.gameId === 'string' && data.gameId.length > 0) socket.join(data.gameId);
        const playersAlreadyInGame = Object.values(players)
            .filter(player => player.gameId === data.gameId).length;
        const spawnOffset = (playersAlreadyInGame % 4) * 4;
        players[socket.id] = {
            x: spawnOffset,
            y: 0,
            z: data.gameType === 'island' ? 0 : 35,
            name: joiningName,
            device: String(data.device || players[socket.id]?.device || 'Unknown'),
            color: data.color,
            gameId: data.gameId,
            appearance: data.appearance,
            gameType: data.gameType,
            gameTitle: data.gameTitle,
            gameIsUserCreated: data.gameIsUserCreated,
            spawnItems: Array.isArray(data.spawnItems) ? data.spawnItems.filter(item => ['gravityCoil', 'speedCoil', 'sword', 'waterGun'].includes(item)) : [],
            chatMessage: ""
        };
        // Send all current players to the newly joined player
        const sameGamePlayers = Object.fromEntries(
            Object.entries(players).filter(([, player]) => player.gameId === data.gameId)
        );
        socket.emit('current_players', sameGamePlayers);
        // Broadcast the new player to everyone else
        io.to(data.gameId).emit('player_joined', { id: socket.id, player: players[socket.id] });
        socket.emit('placed_blocks', placedBlocks.filter(block => block.gameId === data.gameId));
        socket.emit('deleted_map_parts', deletedMapParts.filter(part => part.gameId === data.gameId));
        sendFriendList(socket.id);
        refreshOnlineFriendLists(joiningName);
        if (friendAlreadyInGame) {
            io.to(friendAlreadyInGame[0]).emit('friend_joined', { playerName: joiningName });
        }
        broadcastGamePlayerCounts();
    });

    socket.on('place_block', (data) => {
        const block = {
            id: typeof data.id === 'string' ? data.id : `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            gameType: data.gameType,
            gameId: data.gameId,
            x: Number(data.x),
            y: Number(data.y),
            z: Number(data.z),
            size: Number(data.size),
            color: String(data.color).toLowerCase()
        };

        if (!isValidBlock(block) || Math.abs(block.x) > 150 || Math.abs(block.y) > 150 || Math.abs(block.z) > 150) {
            return;
        }
        if (!players[socket.id] || players[socket.id].gameId !== block.gameId) return;

        placedBlocks.push(block);
        savePlacedBlocks();
        io.to(block.gameId).emit('block_placed', block);
    });

    socket.on('delete_block', (data) => {
        const blockIndex = placedBlocks.findIndex(block => block.id === data.id);
        if (blockIndex === -1) return;
        const block = placedBlocks[blockIndex];
        if (!players[socket.id] || players[socket.id].gameId !== block.gameId) return;

        const [deletedBlock] = placedBlocks.splice(blockIndex, 1);
        savePlacedBlocks();
        io.to(deletedBlock.gameId).emit('block_deleted', { id: deletedBlock.id, gameId: deletedBlock.gameId });
    });

    socket.on('delete_map_part', (data) => {
        if (typeof data.gameId !== 'string' || typeof data.mapPartId !== 'string') return;
        if (!players[socket.id] || players[socket.id].gameId !== data.gameId) return;
        const alreadyDeleted = deletedMapParts.some(part => part.gameId === data.gameId && part.mapPartId === data.mapPartId);
        if (alreadyDeleted) return;

        const deletedPart = { gameId: data.gameId, mapPartId: data.mapPartId };
        deletedMapParts.push(deletedPart);
        saveDeletedMapParts();
        io.to(data.gameId).emit('map_part_deleted', deletedPart);
    });

    socket.on('update_block', (data) => {
        const block = placedBlocks.find(item => item.id === data.id);
        const color = String(data.color).toLowerCase();
        if (!block || !players[socket.id] || players[socket.id].gameId !== block.gameId || !/^#[0-9a-f]{6}$/i.test(color)) return;

        block.color = color;
        savePlacedBlocks();
        io.to(block.gameId).emit('block_updated', block);
    });

    // Handle movement updates
    socket.on('player_move', (data) => {
        if (players[socket.id] && ['x', 'y', 'z'].every(key => Number.isFinite(data[key])) && ['x', 'y', 'z'].every(key => Math.abs(data[key]) <= 300)) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].z = data.z;
            socket.to(players[socket.id].gameId).emit('player_moved', { id: socket.id, gameId: players[socket.id].gameId, x: data.x, y: data.y, z: data.z });
        }
    });

    socket.on('use_tool', ({ tool, targetId }) => {
        const attacker = players[socket.id];
        const target = players[targetId];
        if (typeof targetId !== 'string' || !attacker || !target || attacker.gameId !== target.gameId || !attacker.spawnItems.includes(tool)) return;
        const now = Date.now();
        if (attacker.lastToolUse && now - attacker.lastToolUse < 450) return;
        attacker.lastToolUse = now;

        const distance = Math.hypot(attacker.x - target.x, attacker.z - target.z);
        if (distance > 5) return;

        if (tool === 'sword') {
            target.x = 0;
            target.y = 0;
            target.z = target.gameType === 'island' ? 0 : 35;
            io.to(target.gameId).emit('player_killed', { id: targetId, by: attacker.name });
            setTimeout(() => {
                if (players[targetId]?.gameId === target.gameId) {
                    io.to(target.gameId).emit('player_respawned', { id: targetId, player: players[targetId] });
                }
            }, 1500);
        } else {
            const pushX = target.x - attacker.x;
            const pushZ = target.z - attacker.z;
            const length = Math.hypot(pushX, pushZ) || 1;
            target.x += (pushX / length) * 2;
            target.z += (pushZ / length) * 2;
            io.to(target.gameId).emit('water_hit', { id: targetId, x: target.x, y: target.y, z: target.z, by: attacker.name });
            io.to(target.gameId).emit('player_moved', { id: targetId, gameId: target.gameId, x: target.x, y: target.y, z: target.z });
        }
    });

    socket.on('leave_game', () => {
        const leavingPlayer = players[socket.id];
        const leavingGameId = leavingPlayer?.gameId;
        if (leavingGameId) socket.leave(leavingGameId);
        delete players[socket.id];
        if (leavingGameId) io.to(leavingGameId).emit('player_disconnected', socket.id);
        broadcastGamePlayerCounts();
        if (leavingPlayer) refreshOnlineFriendLists(leavingPlayer.name);
    });

    socket.on('friend_request', ({ targetId }) => {
        const sender = players[socket.id];
        const target = players[targetId];
        if (!sender || !target || targetId === socket.id) return;
        const requests = pendingFriendRequests.get(targetId) || [];
        if (!requests.some(request => request.fromId === socket.id)) {
            requests.push({ fromId: socket.id, fromName: sender.name });
            pendingFriendRequests.set(targetId, requests);
        }
        io.to(targetId).emit('friend_request_received', { fromId: socket.id, fromName: sender.name });
    });

    socket.on('friend_request_response', ({ fromId, accepted }) => {
        const recipient = players[socket.id];
        const requester = players[fromId];
        if (!recipient || !requester) return;
        const requests = pendingFriendRequests.get(socket.id) || [];
        pendingFriendRequests.set(socket.id, requests.filter(request => request.fromId !== fromId));
        if (accepted) {
            if (!friendships.has(recipient.name)) friendships.set(recipient.name, new Set());
            if (!friendships.has(requester.name)) friendships.set(requester.name, new Set());
            friendships.get(recipient.name).add(requester.name);
            friendships.get(requester.name).add(recipient.name);
            saveFriendships();
            sendFriendList(socket.id);
            sendFriendList(fromId);
        }
    });

    // Handle chat messages
    socket.on('send_chat', (message) => {
        if (players[socket.id]) {
            const safeMessage = String(message).slice(0, 160);
            players[socket.id].chatMessage = safeMessage;
            const chatEvent = {
                id: socket.id,
                gameId: players[socket.id].gameId,
                message: safeMessage
            };
            if (players[socket.id].gameId) {
                io.to(players[socket.id].gameId).emit('chat_broadcast', chatEvent);
            } else {
                socket.broadcast.emit('chat_broadcast', chatEvent);
            }
            
            // Clear message after 6 seconds
            setTimeout(() => {
                if (players[socket.id]) {
                    players[socket.id].chatMessage = "";
                }
            }, 6000);
        }
    });

    // Handle player disconnects
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        const disconnectedPlayer = players[socket.id];
        const disconnectedGameId = disconnectedPlayer?.gameId;
        delete players[socket.id];
        if (disconnectedGameId) io.to(disconnectedGameId).emit('player_disconnected', socket.id);
        broadcastGamePlayerCounts();
        if (disconnectedPlayer) refreshOnlineFriendLists(disconnectedPlayer.name);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


