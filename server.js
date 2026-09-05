const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.GONBLOX_ALLOWED_ORIGINS || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const io = new Server(server, {
    maxHttpBufferSize: 8 * 1024 * 1024,
    cors: { origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins, methods: ['GET', 'POST'] }
});
const blocksFile = path.join(__dirname, 'placed-blocks.json');
const deletedMapPartsFile = path.join(__dirname, 'deleted-map-parts.json');
const friendshipsFile = path.join(__dirname, 'friendships.json');
const walletsFile = path.join(__dirname, 'gonbux-wallets.json');
const gonbuxClaimsFile = path.join(__dirname, 'gonbux-guide-claims.json');

// Serve the project root, where index.html is located.
app.use(express.static('.'));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build')));

const players = {};
const friendships = new Map();
const pendingFriendRequests = new Map();
const wallets = new Map();
const gonbuxGuideClaims = new Set();
const mailContacts = new Map();
const mailMessages = new Map();
let placedBlocks = [];
let deletedMapParts = [];

try {
    if (fs.existsSync(gonbuxClaimsFile)) {
        const savedClaims = JSON.parse(fs.readFileSync(gonbuxClaimsFile, 'utf8'));
        if (Array.isArray(savedClaims)) savedClaims.forEach(name => gonbuxGuideClaims.add(String(name)));
    }
} catch (error) {
    console.error('Could not load Gonbux guide claims:', error.message);
}

function saveGonbuxGuideClaims() {
    try {
        fs.writeFileSync(gonbuxClaimsFile, JSON.stringify([...gonbuxGuideClaims], null, 2));
    } catch (error) {
        console.error('Could not save Gonbux guide claims:', error.message);
    }
}
const allowedBlockSizes = new Set([2, 4, 6, 8]);

try {
    if (fs.existsSync(walletsFile)) {
        const savedWallets = JSON.parse(fs.readFileSync(walletsFile, 'utf8'));
        Object.entries(savedWallets).forEach(([name, balance]) => wallets.set(name, Number(balance) || 0));
    }
} catch (error) {
    console.error('Could not load Gonbux wallets:', error.message);
}

function getWallet(playerName) {
    if (!wallets.has(playerName)) wallets.set(playerName, 100);
    return wallets.get(playerName);
}

function saveWallets() {
    try {
        fs.writeFileSync(walletsFile, JSON.stringify(Object.fromEntries(wallets), null, 2));
    } catch (error) {
        console.error('Could not save Gonbux wallets:', error.message);
    }
}

function emitWallet(socketId) {
    const player = players[socketId];
    if (player) io.to(socketId).emit('gonbux_balance', getWallet(player.name));
}

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
            gameShader: onlinePlayer?.gameShader || 'classic',
            gameSky: onlinePlayer?.gameSky || '',
            gameCameraMode: onlinePlayer?.gameCameraMode || 'both',
            gameParts: Array.isArray(onlinePlayer?.gameParts) ? onlinePlayer.gameParts : [],
            gameScript: typeof onlinePlayer?.gameScript === 'string' ? onlinePlayer.gameScript : '',
            gameDeletedMapParts: Array.isArray(onlinePlayer?.gameDeletedMapParts) ? onlinePlayer.gameDeletedMapParts : [],
            gameGuis: Array.isArray(onlinePlayer?.gameGuis) ? onlinePlayer.gameGuis : [],
            gameGuiActions: Array.isArray(onlinePlayer?.gameGuiActions) ? onlinePlayer.gameGuiActions : [],
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

function getMailConversationKey(firstName, secondName) {
    return [firstName, secondName].sort().join('|');
}

function sendMailContacts(socketId) {
    const player = players[socketId];
    if (!player) return;
    const contacts = [...(mailContacts.get(player.name) || new Set())].map(name => ({
        name,
        online: Object.values(players).some(candidate => candidate.name === name)
    }));
    io.to(socketId).emit('mail_contacts', contacts);
}

function findPlayerSocketByName(name) {
    return Object.entries(players).find(([, player]) => player.name === name)?.[0];
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
        ['square', 'triangle', 'sphere', 'cylinder'].includes(block.shape) &&
        ['rotationX', 'rotationY', 'rotationZ'].every(key => Number.isFinite(block[key]) && block[key] >= 0 && block[key] <= 360) &&
        ['scaleX', 'scaleY', 'scaleZ'].every(key => Number.isFinite(block[key]) && block[key] >= 0.1 && block[key] <= 5) &&
        /^#[0-9a-f]{6}$/i.test(block.color) &&
        (!block.image || (typeof block.image === 'string' && block.image.length <= 7 * 1024 * 1024)) &&
        (!block.imageName || typeof block.imageName === 'string') &&
        (!block.texture || (typeof block.texture === 'string' && /^\/Textures\/[\w%(). -]+\.png$/i.test(block.texture))) &&
        (!block.textureName || (typeof block.textureName === 'string' && block.textureName.length <= 120)) &&
        Number.isFinite(block.textureShade) && block.textureShade >= 25 && block.textureShade <= 150 &&
        ['park', 'island', 'beach', 'baseplate'].includes(block.gameType);
}

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('identify_user', (data) => {
        let mailCode = Math.random().toString(36).slice(2, 8).toUpperCase();
        while (Object.values(players).some(player => player.mailCode === mailCode)) {
            mailCode = Math.random().toString(36).slice(2, 8).toUpperCase();
        }
        players[socket.id] = {
            name: String(data.name || 'Player'),
            mailCode,
            device: String(data.device || 'Unknown'),
            appearance: data.appearance || null,
            gameId: null,
            gameType: null,
            gameTitle: null,
            gameShader: 'classic',
            gameSky: '',
            gameCameraMode: 'both',
            gameParts: [],
            gameScript: '',
            gameDeletedMapParts: [],
            gameIsUserCreated: false,
            chatMessage: ''
        };
        sendFriendList(socket.id);
        sendMailContacts(socket.id);
        socket.emit('mail_code', mailCode);
        socket.emit('gonbux_guide_status', { claimed: gonbuxGuideClaims.has(players[socket.id].name) });
        emitWallet(socket.id);
    });

    socket.on('earn_gonbux', ({ amount, reason }) => {
        const player = players[socket.id];
        const safeAmount = Number(amount);
        const allowedReasons = new Set(['play', 'publish']);
        if (!player || !Number.isInteger(safeAmount) || safeAmount < 1 || safeAmount > 50 || !allowedReasons.has(reason)) return;
        wallets.set(player.name, getWallet(player.name) + safeAmount);
        saveWallets();
        emitWallet(socket.id);
    });

    socket.on('claim_gonbux_guide', () => {
        const player = players[socket.id];
        if (!player || gonbuxGuideClaims.has(player.name)) {
            socket.emit('gonbux_guide_status', { claimed: true });
            return;
        }
        gonbuxGuideClaims.add(player.name);
        wallets.set(player.name, getWallet(player.name) + 10);
        saveGonbuxGuideClaims();
        saveWallets();
        emitWallet(socket.id);
        socket.emit('gonbux_guide_claimed');
    });

    socket.on('spend_gonbux', ({ amount }) => {
        const player = players[socket.id];
        const safeAmount = Number(amount);
        if (!player || !Number.isInteger(safeAmount) || safeAmount < 1 || safeAmount > 10000 || getWallet(player.name) < safeAmount) {
            socket.emit('gonbux_error', 'Not enough Gonbux.');
            return;
        }
        wallets.set(player.name, getWallet(player.name) - safeAmount);
        saveWallets();
        emitWallet(socket.id);
        socket.emit('gonbux_spent', { amount: safeAmount });
    });

    socket.on('gift_gonbux', ({ targetId, amount }) => {
        const sender = players[socket.id];
        const recipient = players[targetId];
        const safeAmount = Number(amount);
        if (!sender || !recipient || targetId === socket.id || !Number.isInteger(safeAmount) || safeAmount < 1 || safeAmount > 10000) {
            socket.emit('gonbux_error', 'Enter a valid gift amount and recipient.');
            return;
        }
        if (getWallet(sender.name) < safeAmount) {
            socket.emit('gonbux_error', 'You do not have enough Gonbux for that gift.');
            return;
        }
        wallets.set(sender.name, getWallet(sender.name) - safeAmount);
        wallets.set(recipient.name, getWallet(recipient.name) + safeAmount);
        saveWallets();
        emitWallet(socket.id);
        io.to(targetId).emit('gonbux_gift_received', { from: sender.name, amount: safeAmount });
        socket.emit('gonbux_gift_sent', { to: recipient.name, amount: safeAmount });
    });

    socket.on('update_appearance', ({ appearance }) => {
        if (!players[socket.id]) return;
        players[socket.id].appearance = appearance || null;
        sendFriendList(socket.id);
        refreshOnlineFriendLists(players[socket.id].name);
    });

    socket.on('search_players', (query) => {
        const player = players[socket.id];
        if (!player) return;
        const searchTerm = String(query || '').trim().toLowerCase().slice(0, 32);
        const results = Object.entries(players)
            .filter(([id, candidate]) => id !== socket.id && candidate.name.toLowerCase().includes(searchTerm))
            .slice(0, 25)
            .map(([id, candidate]) => ({
                name: candidate.name,
                playerId: id,
                online: true,
                gameId: candidate.gameId || null,
                gameType: candidate.gameType || null,
                gameTitle: candidate.gameTitle || null,
                gameShader: candidate.gameShader || 'classic',
                gameSky: candidate.gameSky || '',
                gameCameraMode: candidate.gameCameraMode || 'both',
                gameIsUserCreated: Boolean(candidate.gameIsUserCreated),
                gameParts: Array.isArray(candidate.gameParts) ? candidate.gameParts : [],
                gameScript: typeof candidate.gameScript === 'string' ? candidate.gameScript : '',
                gameDeletedMapParts: Array.isArray(candidate.gameDeletedMapParts) ? candidate.gameDeletedMapParts : [],
                gameGuis: Array.isArray(candidate.gameGuis) ? candidate.gameGuis : [],
                gameGuiActions: Array.isArray(candidate.gameGuiActions) ? candidate.gameGuiActions : [],
                appearance: candidate.appearance || null,
                isFriend: (friendships.get(player.name) || new Set()).has(candidate.name)
            }));
        socket.emit('player_search_results', results);
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
                gameShader: ['none', 'classic', 'neon', 'sunset', 'moonlight'].includes(data.gameShader) ? data.gameShader : 'classic',
                gameSky: typeof data.gameSky === 'string' && data.gameSky.length <= 7 * 1024 * 1024 ? data.gameSky : '',
                gameCameraMode: ['first', 'third', 'both'].includes(data.gameCameraMode) ? data.gameCameraMode : 'both',
            gameParts: Array.isArray(data.gameParts) ? data.gameParts.slice(0, 100) : [],
            gameScript: typeof data.gameScript === 'string' ? data.gameScript.slice(0, 4000) : '',
            gameDeletedMapParts: Array.isArray(data.gameDeletedMapParts) ? data.gameDeletedMapParts.slice(0, 100) : [],
            gameGuis: Array.isArray(data.gameGuis) ? data.gameGuis.slice(0, 50) : [],
            gameGuiActions: Array.isArray(data.gameGuiActions) ? data.gameGuiActions.slice(0, 100) : [],
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
            shape: ['square', 'triangle', 'sphere', 'cylinder'].includes(data.shape) ? data.shape : 'square',
            rotationX: Number(data.rotationX) || 0,
            rotationY: Number(data.rotationY) || 0,
            rotationZ: Number(data.rotationZ) || 0,
            scaleX: Number(data.scaleX) || 1,
            scaleY: Number(data.scaleY) || 1,
            scaleZ: Number(data.scaleZ) || 1,
            color: String(data.color).toLowerCase(),
            image: typeof data.image === 'string' ? data.image.slice(0, 7 * 1024 * 1024) : '',
            imageName: typeof data.imageName === 'string' ? data.imageName.slice(0, 120) : '',
            texture: typeof data.texture === 'string' ? data.texture.slice(0, 200) : '',
            textureName: typeof data.textureName === 'string' ? data.textureName.slice(0, 120) : '',
            textureShade: Number(data.textureShade) || 100
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

    socket.on('restore_map_part', (data) => {
        if (typeof data.gameId !== 'string' || typeof data.mapPartId !== 'string') return;
        if (!players[socket.id] || players[socket.id].gameId !== data.gameId) return;
        const partIndex = deletedMapParts.findIndex(part => part.gameId === data.gameId && part.mapPartId === data.mapPartId);
        if (partIndex === -1) return;
        const [restoredPart] = deletedMapParts.splice(partIndex, 1);
        saveDeletedMapParts();
        io.to(data.gameId).emit('map_part_restored', restoredPart);
    });

    socket.on('restore_all_map_parts', ({ gameId }) => {
        if (typeof gameId !== 'string' || !players[socket.id] || players[socket.id].gameId !== gameId) return;
        const remainingParts = deletedMapParts.filter(part => part.gameId !== gameId);
        if (remainingParts.length === deletedMapParts.length) return;
        deletedMapParts = remainingParts;
        saveDeletedMapParts();
        io.to(gameId).emit('map_parts_restored_all', { gameId });
    });

    socket.on('update_block', (data) => {
        const block = placedBlocks.find(item => item.id === data.id);
        if (!block || !players[socket.id] || players[socket.id].gameId !== block.gameId) return;

        if (data.color !== undefined) {
            const color = String(data.color).toLowerCase();
            if (!/^#[0-9a-f]{6}$/i.test(color)) return;
            block.color = color;
        }
        if (data.texture !== undefined || data.textureName !== undefined || data.textureShade !== undefined) {
            const texture = typeof data.texture === 'string' ? data.texture : block.texture || '';
            const textureName = typeof data.textureName === 'string' ? data.textureName : block.textureName || '';
            const textureShade = data.textureShade === undefined ? block.textureShade : Number(data.textureShade);
            if (texture && !/^\/Textures\/[\w%(). -]+\.png$/i.test(texture)) return;
            if (textureName.length > 120 || !Number.isFinite(textureShade) || textureShade < 25 || textureShade > 150) return;
            block.texture = texture;
            block.textureName = textureName;
            block.textureShade = textureShade;
        }
        if (data.rotationX !== undefined || data.rotationY !== undefined || data.rotationZ !== undefined) {
            const rotations = [data.rotationX, data.rotationY, data.rotationZ].map(value => Number(value));
            if (rotations.some(value => !Number.isFinite(value) || value < 0 || value > 360)) return;
            [block.rotationX, block.rotationY, block.rotationZ] = rotations;
        }
        if (data.scaleX !== undefined || data.scaleY !== undefined || data.scaleZ !== undefined) {
            const scales = [data.scaleX, data.scaleY, data.scaleZ].map(value => Number(value));
            if (scales.some(value => !Number.isFinite(value) || value < 0.1 || value > 5)) return;
            [block.scaleX, block.scaleY, block.scaleZ] = scales;
        }
        if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
            const positions = [data.x, data.y, data.z].map(value => Number(value));
            if (positions.some(value => !Number.isFinite(value) || Math.abs(value) > 150)) return;
            [block.x, block.y, block.z] = positions;
        }
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

    socket.on('add_mail_contact', (code) => {
        const sender = players[socket.id];
        const safeCode = String(code || '').trim().toUpperCase().slice(0, 12);
        const targetEntry = Object.entries(players).find(([, player]) => player.mailCode === safeCode);
        if (!sender || !targetEntry || targetEntry[0] === socket.id) {
            socket.emit('mail_error', 'That mail code is not available.');
            return;
        }
        const target = targetEntry[1];
        if (!mailContacts.has(sender.name)) mailContacts.set(sender.name, new Set());
        if (!mailContacts.has(target.name)) mailContacts.set(target.name, new Set());
        mailContacts.get(sender.name).add(target.name);
        mailContacts.get(target.name).add(sender.name);
        sendMailContacts(socket.id);
        sendMailContacts(targetEntry[0]);
        socket.emit('mail_contact_added', target.name);
    });

    socket.on('get_mail_messages', (contactName) => {
        const sender = players[socket.id];
        const contact = String(contactName || '').trim();
        if (!sender || !(mailContacts.get(sender.name) || new Set()).has(contact)) return;
        socket.emit('mail_messages', { contact, messages: mailMessages.get(getMailConversationKey(sender.name, contact)) || [] });
    });

    socket.on('send_mail_message', ({ contactName, message }) => {
        const sender = players[socket.id];
        const contact = String(contactName || '').trim();
        const text = String(message || '').trim().slice(0, 240);
        if (!sender || !text || !(mailContacts.get(sender.name) || new Set()).has(contact)) return;
        const recipientSocketId = findPlayerSocketByName(contact);
        const entry = { from: sender.name, message: text, timestamp: Date.now() };
        const conversationKey = getMailConversationKey(sender.name, contact);
        const conversation = mailMessages.get(conversationKey) || [];
        conversation.push(entry);
        mailMessages.set(conversationKey, conversation.slice(-100));
        socket.emit('mail_message', { contact, ...entry });
        if (recipientSocketId) io.to(recipientSocketId).emit('mail_message', { contact: sender.name, ...entry });
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

    socket.on('broadcast_message', (message) => {
        const sender = players[socket.id];
        const text = String(message || '').trim().slice(0, 80);
        if (!sender || !sender.gameId || !text) return;
        io.to(sender.gameId).emit('game_broadcast', { id: socket.id, message: text });
    });

    // Handle player disconnects
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        const disconnectedPlayer = players[socket.id];
        const disconnectedGameId = disconnectedPlayer?.gameId;
        delete players[socket.id];
        if (disconnectedGameId) io.to(disconnectedGameId).emit('player_disconnected', socket.id);
        broadcastGamePlayerCounts();
        if (disconnectedPlayer) {
            refreshOnlineFriendLists(disconnectedPlayer.name);
            for (const [socketId, player] of Object.entries(players)) {
                if ((mailContacts.get(player.name) || new Set()).has(disconnectedPlayer.name)) sendMailContacts(socketId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


